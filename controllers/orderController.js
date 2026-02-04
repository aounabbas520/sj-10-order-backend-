const db = require('../config/database');
const { clients } = require('../config/tursoConnection');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios'); 
const { calculateCommission } = require('../utils/commissionCalculator');
const { calculateDeliveryFee } = require('../utils/deliveryCalculator');

// ==============================================================================
// 1. HELPER: Notify Supplier Backend
// ==============================================================================
const notifySupplierBackend = async (action, payload) => {
    try {
        const url = `${process.env.SUPPLIER_BACKEND_URL}/api/internal/sync/${action}`;
        // We use fire-and-forget (no await) so the user doesn't wait for the supplier server
        axios.post(url, payload, {
            headers: { 
                'x-internal-api-key': process.env.INTERNAL_API_KEY,
                'Content-Type': 'application/json'
            },
            timeout: 10000 
        }).catch(err => console.error(`⚠️ Supplier Notification Failed: ${err.message}`));
    } catch (error) {
        console.error(`⚠️ Notification Setup Error: ${error.message}`);
    }
};

// ==============================================================================
// 2. HELPER: Fetch Products (Updated: Fetches 'colors' and 'sizes')
// ==============================================================================
const fetchProductDetailsFromTurso = async (productIds) => {
    if (!productIds || productIds.length === 0) return new Map();
    const uniqueIds = [...new Set(productIds)].filter(id => id); 

    const promises = Object.values(clients).map(async (client) => {
        try {
            const placeholders = uniqueIds.map(() => '?').join(',');
            // ✅ ADDED: 'colors' and 'sizes' to query for fallback logic
            const res = await client.execute({
                sql: `SELECT id, title, image_urls, price, discounted_price, supplier_id, package_information, colors, sizes 
                      FROM products WHERE id IN (${placeholders})`,
                args: uniqueIds
            });
            return res.rows;
        } catch (e) { return []; }
    });

    const results = (await Promise.all(promises)).flat();
    const map = new Map();
    results.forEach(p => {
        map.set(String(p.id).trim(), { 
            ...p, 
            final_price: p.discounted_price || p.price 
        });
    });
    return map;
};

// ==============================================================================
// 3. HELPER: Fetch Variants (Updated: Strict ID Matching)
// ==============================================================================
const fetchVariantsFromTurso = async (variantIds) => {
    const uniqueIds = [...new Set(variantIds)].filter(id => id).map(id => String(id).trim());
    
    if (uniqueIds.length === 0) return new Map();

    const promises = Object.entries(clients).map(async ([shardName, client]) => {
        if (!client) return [];
        try {
            const placeholders = uniqueIds.map(() => '?').join(',');
            // We fetch specific columns. Note: 'sku' is fetched for logic, but NOT saved to options.
            const sql = `SELECT id, custom_color, custom_size, sku, price 
                         FROM variants 
                         WHERE CAST(id AS TEXT) IN (${placeholders})`;
            
            const res = await client.execute({ sql, args: uniqueIds });
            return res.rows;
        } catch (e) { 
            return []; 
        }
    });

    const results = (await Promise.all(promises)).flat();
    const map = new Map();
    results.forEach(v => map.set(String(v.id).trim(), v));
    return map;
};

// ==============================================================================
// 4. MAIN API: Create Order
// ==============================================================================
exports.createOrder = async (req, res) => {
    const orderConnection = await db.orders.getConnection();
    const cartConnection = await db.carts.getConnection();

    try {
        const userId = req.user.id;
        const { customer_name, customer_phone, customer_address, items, customer_email, customer_city } = req.body;
        
        await orderConnection.beginTransaction();
        await cartConnection.beginTransaction();

        // =========================================================
        // STEP A: Normalize Items (Direct Buy vs Cart Buy)
        // =========================================================
        let rawItemsToProcess = [];
        let isDirectBuy = false;

        if (items && items.length > 0) {
            // Direct Buy
            isDirectBuy = true;
            rawItemsToProcess = items.map(item => ({
                product_id: String(item.productId).trim(), 
                quantity: Number(item.quantity) || 1, 
                options: item.options || {}, 
                profit: Number(item.profit || item.options?.profit || 0)
            }));
        } else {
            // Cart Buy
            const [cartRows] = await cartConnection.query("SELECT * FROM cart WHERE user_id = ?", [userId]);
            if (cartRows.length === 0) throw new Error("Cart is empty.");
            
            rawItemsToProcess = cartRows.map(row => {
                const opts = (typeof row.options === 'string') ? JSON.parse(row.options) : {};
                return {
                    product_id: String(row.product_id).trim(),
                    quantity: Number(row.quantity) || 1,
                    options: opts,
                    profit: Number(row.profit || opts.profit || 0)
                };
            });
        }

        // =========================================================
        // STEP B: Parallel Data Fetching (Fastest Method)
        // =========================================================
        const productIds = rawItemsToProcess.map(item => item.product_id);
        const variantIds = rawItemsToProcess.map(item => item.options?.variantId).filter(id => id);

        // Fetch both datasets simultaneously to reduce wait time
        const [productMap, variantMap] = await Promise.all([
            fetchProductDetailsFromTurso(productIds),
            fetchVariantsFromTurso(variantIds)
        ]);

        const createdOrderIds = [];
        const supplierNotificationPayload = [];

        // =========================================================
        // STEP C: Process Items Loop
        // =========================================================
        for (const item of rawItemsToProcess) {
            const product = productMap.get(item.product_id);
            if (!product) throw new Error(`Product ${item.product_id} is unavailable.`);

            // --- 1. INITIALIZE DEFAULTS (From Product Table) ---
            let basePrice = Number(product.final_price);
            
            // Clean strings: Remove ["brackets"] or "quotes" if Turso stored them as JSON strings
            let color = product.colors ? String(product.colors).replace(/[\[\]"]/g, '').trim() : "Standard";
            let size = product.sizes ? String(product.sizes).replace(/[\[\]"]/g, '').trim() : "Standard";
            
            // --- 2. VARIANT LOGIC (Highest Priority) ---
            const incomingVariantId = item.options?.variantId ? String(item.options.variantId).trim() : null;

            if (incomingVariantId) {
                const variant = variantMap.get(incomingVariantId);
                
                if (variant) {
                    console.log(`✅ [Backend] Applying Variant: ${incomingVariantId}`);
                    
                    // Priority Overwrite: If variant has specific data, replace product default
                    if (variant.custom_color && variant.custom_color !== 'null') color = variant.custom_color;
                    if (variant.custom_size && variant.custom_size !== 'null') size = variant.custom_size;
                    
                    // Variant Price takes precedence
                    basePrice = Number(variant.price); 
                } else {
                    console.warn(`⚠️ [Backend] Variant ${incomingVariantId} not found. Falling back to Product data.`);
                }
            }

            // --- 3. CALCULATIONS ---
            const itemProfit = Number(item.profit); 
            const quantity = Number(item.quantity);

            // Calculate Delivery Fee (Dynamic based on weight)
            const deliveryFeePerUnit = calculateDeliveryFee(product.package_information);
            const totalDeliveryFee = deliveryFeePerUnit * quantity;

            // Calculate Totals
            const productTotal = (basePrice + itemProfit) * quantity;
            const orderGrandTotal = productTotal + totalDeliveryFee; 
            const systemCommission = calculateCommission(basePrice) * quantity;

            // --- 4. GENERATE IDs ---
            const newOrderId = uuidv4();
            const newShipmentId = uuidv4();
            const supplierId = product.supplier_id || 'unknown';

            // --- 5. INSERT INTO ORDERS TABLE ---
            await orderConnection.execute(
                `INSERT INTO orders (id, user_id, customer_name, customer_phone, customer_email, customer_address, customer_city, total_price, total_delivery_charge, status, created_at) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Processing', NOW())`,
                [newOrderId, userId, customer_name, customer_phone, customer_email, customer_address, customer_city || "Unknown", orderGrandTotal, totalDeliveryFee]
            );

            // --- 6. INSERT INTO SHIPMENTS TABLE ---
            await orderConnection.execute(
                "INSERT INTO shipments (id, order_id, supplier_id, current_status, created_at) VALUES (?, ?, ?, 'processing', NOW())", 
                [newShipmentId, newOrderId, supplierId]
            );

            // --- 7. CLEAN OPTIONS JSON (The Fix) ---
            // We ONLY save what the customer/admin needs to see. 
            // NO variantId, NO sku, NO nulls.
            const optionsToSave = {};
            
            // Logic: Use the final calculated 'color' and 'size'.
            // If they are empty or null, default to "Standard"
            optionsToSave.color = (color && color !== 'null' && color !== '') ? color : "Standard";
            optionsToSave.size = (size && size !== 'null' && size !== '') ? size : "Standard";

            console.log(`[DB Save] Options for ${item.product_id}:`, JSON.stringify(optionsToSave));

            // --- 8. INSERT INTO ORDER_ITEMS TABLE ---
            await orderConnection.execute(
                `INSERT INTO order_items 
                (order_id, product_id, quantity, price_at_purchase, options, profit, system_commission, delivery_charge, commission_status) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`, 
                [
                    newOrderId,
                    item.product_id,
                    quantity,
                    basePrice, // Correct final price
                    JSON.stringify(optionsToSave), 
                    itemProfit,                  
                    systemCommission,
                    totalDeliveryFee
                ]
            );

            createdOrderIds.push(newOrderId);
            
            // --- 9. PREPARE NOTIFICATION PAYLOAD ---
            supplierNotificationPayload.push({
                orderId: newOrderId,
                supplierId: supplierId,
                productName: product.title,
                variant: `${optionsToSave.color} | ${optionsToSave.size}`, // Send clear readable string
                quantity: quantity,
                city: customer_city || "Unknown",
                itemTotal: productTotal, 
                customerName: customer_name,
                status: "Processing"
            });
        }

        // =========================================================
        // STEP D: COMMIT & CLEANUP
        // =========================================================
        if (!isDirectBuy) {
            await cartConnection.execute("DELETE FROM cart WHERE user_id = ?", [userId]);
        }

        await orderConnection.commit();
        await cartConnection.commit();

        res.status(201).json({ message: `Successfully placed orders!`, orderIds: createdOrderIds });

        // =========================================================
        // STEP E: NOTIFY SUPPLIER (ASYNC)
        // =========================================================
        notifySupplierBackend('new-order', { orders: supplierNotificationPayload });

    } catch (error) {
        await orderConnection.rollback();
        await cartConnection.rollback();
        console.error("Order Creation Failed:", error);
        res.status(500).json({ message: "Failed to create order." });
    } finally {
        orderConnection.release();
        cartConnection.release();
    }
};

// ... existing exports like getMyOrders, cancelOrder, getOrderTracking ...

// ... existing exports ...
// ... keep other exports like getMyOrders, cancelOrder, etc.
// Assuming they are already in your file.
// ==============================================================================
// HELPER: Fetch Suppliers (TiDB)
// ==============================================================================
const fetchSupplierDetailsFromTiDB = async (supplierIds) => {
    if (!supplierIds || supplierIds.length === 0) return new Map();
    const uniqueIds = [...new Set(supplierIds)].filter(id => id && id !== 'unknown');
    if (uniqueIds.length === 0) return new Map();

    try {
        const [rows] = await db.suppliers.query(
            `SELECT id, brand_name, full_name FROM suppliers WHERE id IN (?)`,
            [uniqueIds]
        );
        const map = new Map();
        rows.forEach(s => map.set(s.id, s.brand_name || s.full_name || "Verified Supplier"));
        return map;
    } catch (error) { return new Map(); }
};

// ==============================================================================
// API: Get My Orders
// ==============================================================================
// ==============================================================================
// API: Get My Orders (Fixed Image Logic)
// ==============================================================================
exports.getMyOrders = async (req, res) => {
    try {
        const userId = req.user.id;
        
        // 1. Fetch Orders
        const [orders] = await db.orders.query("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC", [userId]);
        if (orders.length === 0) return res.json([]);

        const orderIds = orders.map(o => o.id);
        
        // 2. Fetch Items & Shipments
        const [items] = await db.orders.query("SELECT * FROM order_items WHERE order_id IN (?)", [orderIds]);
        const [shipments] = await db.orders.query("SELECT * FROM shipments WHERE order_id IN (?)", [orderIds]);

        // 3. Fetch Product & Supplier Details
        const productIds = items.map(i => i.product_id);
        const supplierIds = shipments.map(s => s.supplier_id);
        
        const [productMap, supplierMap] = await Promise.all([
            fetchProductDetailsFromTurso(productIds),
            fetchSupplierDetailsFromTiDB(supplierIds)
        ]);

        // 4. Format Data
        const formattedOrders = orders.map(order => {
            const shipment = shipments.find(s => s.order_id === order.id);
            
            let finalStatus = order.status; 
            let courierName = null;
            let trackingNumber = null;
            let supplierName = "Markaz Supplier";
            let canTrack = false;

            if (shipment) {
                if (shipment.current_status && shipment.current_status !== 'processing' && shipment.current_status !== '') {
                    finalStatus = shipment.current_status;
                }
                if (shipment.supplier_id && supplierMap.has(shipment.supplier_id)) {
                    supplierName = supplierMap.get(shipment.supplier_id);
                }
                courierName = shipment.courier_name;
                trackingNumber = shipment.tracking_number;
                
                const statusLower = (finalStatus || '').toLowerCase();
                if (trackingNumber || ['dispatched', 'shipped', 'in_transit', 'manifested'].some(s => statusLower.includes(s))) {
                    canTrack = true;
                }
            }

            const orderItems = items.filter(i => i.order_id === order.id).map(item => {
                const product = productMap.get(item.product_id) || {};
                
                // --- IMAGE FIX START ---
                let finalImage = null;
                if (product.image_urls) {
                    try {
                        // Check if it's already an array
                        if (Array.isArray(product.image_urls)) {
                            finalImage = product.image_urls[0];
                        } 
                        // Check if it's a JSON string like '["url"]'
                        else if (typeof product.image_urls === 'string') {
                            // Agar bracket se start ho raha hai to JSON parse karo
                            if (product.image_urls.trim().startsWith('[')) {
                                const parsed = JSON.parse(product.image_urls);
                                if (parsed.length > 0) finalImage = parsed[0];
                            } else {
                                // Agar simple string hai
                                finalImage = product.image_urls;
                            }
                        }
                    } catch (e) {
                        // Agar parsing fail ho jaye, to raw string use karlo agar wo URL jaisa lag raha hai
                        if (typeof product.image_urls === 'string' && product.image_urls.startsWith('http')) {
                            finalImage = product.image_urls;
                        }
                        console.error("Image parsing error for product:", item.product_id);
                    }
                }
                // --- IMAGE FIX END ---

                let parsedOptions = {};
                try { parsedOptions = (typeof item.options === 'string') ? JSON.parse(item.options) : item.options; } catch(e) { parsedOptions = {}; }

                const variantParts = [];
                for (const [key, value] of Object.entries(parsedOptions)) {
                    if(!['profit', 'price', 'productId', 'commission'].includes(key) && value) {
                        const label = key.charAt(0).toUpperCase() + key.slice(1);
                        variantParts.push(`${label}: ${value}`);
                    }
                }

                const itemProfit = parseFloat(item.profit) || 0;
                const costPrice = parseFloat(item.price_at_purchase) || 0;

                return {
                    itemId: item.id,
                    productId: item.product_id,
                    title: product.title || "Product Item",
                    image: finalImage, // ✅ Ab yahan sahi URL jayega
                    quantity: item.quantity,
                    variantString: variantParts.join(' | ') || 'Standard',
                    profit: itemProfit, 
                    costPrice: costPrice,
                    options: parsedOptions // Front-end par icons dikhane ke liye options bhi bhej raha hun
                };
            });

            return {
                orderId: order.id,
                date: order.created_at,
                totalPrice: parseFloat(order.total_price),
                deliveryFee: parseFloat(order.total_delivery_charge || 0),
                totalProfit: orderItems.reduce((acc, item) => acc + (item.profit * item.quantity), 0),
                status: (finalStatus || 'Processing').toLowerCase(), 
                canTrack: canTrack,
                supplierName: supplierName,
                customer: {
                    name: order.customer_name,
                    phone: order.customer_phone,
                    address: order.customer_address,
                    city: order.customer_city || "Pakistan"
                },
                courier: {
                    name: courierName,
                    trackingNumber: trackingNumber
                },
                items: orderItems
            };
        });

        res.json(formattedOrders);

    } catch (error) {
        console.error("GetOrders Error:", error);
        res.status(500).json({ message: "Error fetching orders" });
    }
};node

// ==============================================================================
// API: Cancel Order
// ==============================================================================
exports.cancelOrder = async (req, res) => {
    const { orderId } = req.body;
    try {
        // Fetch Customer Name too for the message
        const [rows] = await db.orders.query("SELECT status, customer_name FROM orders WHERE id = ? AND user_id = ?", [orderId, req.user.id]);
        if (rows.length === 0) return res.status(404).json({ message: "Order not found" });

        const customerName = rows[0].customer_name; // <--- Get Name

        const [shipRows] = await db.orders.query("SELECT current_status, supplier_id FROM shipments WHERE order_id = ?", [orderId]);
        const shipStatus = shipRows.length > 0 ? (shipRows[0].current_status || '').toLowerCase() : 'processing';
        const supplierId = shipRows.length > 0 ? shipRows[0].supplier_id : null;

        const nonCancellable = ['dispatched', 'in_transit', 'out_for_delivery', 'delivered', 'shipped', 'returned', 'rto'];
        if (nonCancellable.includes(shipStatus)) {
            return res.status(400).json({ message: "Cannot cancel. Order already dispatched." });
        }

        await db.orders.execute("UPDATE orders SET status = 'Cancelled' WHERE id = ?", [orderId]);
        await db.orders.execute("UPDATE shipments SET current_status = 'cancelled' WHERE order_id = ?", [orderId]);

        res.json({ message: "Order cancelled successfully." });

        if(supplierId) {
            // ✅ Send customerName in cancellation payload
            notifySupplierBackend('cancel-order', { orderId, supplierId, customerName });
        }

    } catch (e) {
        res.status(500).json({ message: "Error cancelling order." });
    }
};


exports.getOrderTracking = async (req, res) => {
    const { orderId } = req.params;
    try {
        const userId = req.user.id;

        // Fetch Data
        const [orders] = await db.orders.query(
            `SELECT 
                o.id, o.created_at, o.status as order_status,
                s.courier_name, s.tracking_number, s.current_status as shipment_status, 
                s.events, s.updated_at, s.supplier_id
             FROM orders o
             LEFT JOIN shipments s ON o.id = s.order_id
             WHERE o.id = ? AND o.user_id = ?`,
            [orderId, userId]
        );

        if (orders.length === 0) return res.status(404).json({ message: "Order not found." });

        const data = orders[0];
        // Priority to Shipment Status
        const status = (data.shipment_status || data.order_status || 'processing').toLowerCase();
        
        let trackingEvents = [];

        // 1. Parse Real Events
        if (data.events && typeof data.events === 'string') {
            try {
                const parsed = JSON.parse(data.events);
                if (Array.isArray(parsed)) trackingEvents = parsed;
            } catch (e) {}
        }

        // 2. Default Events Logic
        if (trackingEvents.length === 0) {
            trackingEvents.push({
                status: 'Order Placed',
                description: 'Your order has been successfully placed.',
                timestamp: data.created_at,
                location: 'System'
            });

            const dispatchedStatuses = ['dispatched', 'in_transit', 'out_for_delivery', 'shipped', 'manifested', 'booked'];
            
            if (dispatchedStatuses.some(ds => status.includes(ds)) || data.tracking_number) {
                trackingEvents.push({
                    status: 'Proceeded to M House', 
                    description: 'Order processed to sorting facility.',
                    timestamp: data.updated_at || new Date().toISOString(),
                    location: 'M House Facility'
                });
            }
        }

        res.json({
            orderId: data.id,
            courier: {
                name: data.courier_name || "Pending",
                trackingNumber: data.tracking_number || "Awaiting"
            },
            currentStatus: status,
            timeline: trackingEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        });

    } catch (error) {
        console.error("Tracking Error:", error);
        res.status(500).json({ message: "Failed to fetch tracking details." });
    }
};