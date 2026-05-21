console.log("🚀 App started");
const express = require("express");
const bodyParser = require("body-parser");
const mysql = require("mysql2");
const session = require("express-session");
const bcrypt = require("bcrypt");
const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.set("view engine", "ejs");

// Sessions
app.use(session({
  secret: "mysecretkey",
  resave: false,
  saveUninitialized: true
}));

// MySQL connection
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "mydb",
});

db.connect((err) => {
  if (err) throw err;
  console.log("✅ Connected to MySQL");
});

// -------- LOGIN PAGE --------
app.get("/", (req, res) => {
  res.render("login", { error: null });
});

// LOGIN POST
// app.post("/login", (req, res) => {
//   const { username, password } = req.body;
//   db.query("SELECT * FROM admins WHERE username = ?", [username], (err, results) => {
//     if (err) throw err;
//     if (results.length === 0) return res.render("login", { error: "Invalid credentials" });

//     // Plain text password check
//     if (results[0].password !== password) {
//       return res.render("login", { error: "Invalid credentials" });
//     }

//     // Set session
//     req.session.user = { id: results[0].id, username: results[0].username, Storename: results[0].Storename };
//     res.redirect("/dashboard");
//   });
// });

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  
  // Added 'role' to the SELECT query
  db.query("SELECT id, username, password, Storename, role FROM admins WHERE username = ?", [username], (err, results) => {
    if (err) throw err;
    if (results.length === 0) return res.render("login", { error: "Invalid credentials" });

    if (results[0].password !== password) {
      return res.render("login", { error: "Invalid credentials" });
    }

    // Set session with the user's role
    req.session.user = { 
      id: results[0].id, 
      username: results[0].username, 
      Storename: results[0].Storename,
      role: results[0].role // This will be 'admin' or 'cashier'
    };
    
    res.redirect("/dashboard");
  });
});

// -------- DASHBOARD --------
function isLoggedIn(req, res, next) {
  if (req.session.user) return next();
  res.redirect("/login");
}

// app.get("/dashboard", isLoggedIn, (req, res) => {
//   res.render("layouts/dashboard", { user: req.session.user });
// });

app.get("/dashboard", isLoggedIn, (req, res) => {
  const queries = {
    totalProducts: "SELECT COUNT(*) AS total FROM inventory",
    totalSales: "SELECT COUNT(*) AS total FROM sales",
    todayRevenue: "SELECT IFNULL(SUM(total),0) AS total FROM sales WHERE DATE(created_at) = CURDATE()",
    lowStockCount: "SELECT COUNT(*) AS total FROM inventory WHERE stock <= 5",
    lowStockProducts: "SELECT * FROM inventory WHERE stock <= 5 ORDER BY stock ASC LIMIT 5",
    recentSales: "SELECT * FROM sales ORDER BY id DESC LIMIT 5",
    todayProfit: `
      SELECT IFNULL(SUM((si.price - si.buy_price) * si.quantity), 0) AS profit 
      FROM sale_items si 
      JOIN sales s ON si.sale_id = s.id 
      WHERE DATE(s.created_at) = CURDATE()`,
    financialSummary: `
      SELECT 
        SUM(CASE WHEN entity_type = 'customer' THEN (CASE WHEN transaction_type = 'debit' THEN amount ELSE -amount END) ELSE 0 END) as totalReceivables,
        SUM(CASE WHEN entity_type = 'vendor' THEN (CASE WHEN transaction_type = 'credit' THEN amount ELSE -amount END) ELSE 0 END) as totalPayables
      FROM account_ledger`
  };

  Promise.all([
    new Promise(resolve => db.query(queries.totalProducts, (e, r) => resolve(r[0].total))),
    new Promise(resolve => db.query(queries.totalSales, (e, r) => resolve(r[0].total))),
    new Promise(resolve => db.query(queries.todayRevenue, (e, r) => resolve(r[0].total))),
    new Promise(resolve => db.query(queries.lowStockCount, (e, r) => resolve(r[0].total))),
    new Promise(resolve => db.query(queries.lowStockProducts, (e, r) => resolve(r))), 
    new Promise(resolve => db.query(queries.recentSales, (e, r) => resolve(r))),
    new Promise(resolve => db.query(queries.todayProfit, (e, r) => resolve(r[0].profit))),
    new Promise(resolve => db.query(queries.financialSummary, (e, r) => resolve(r[0]))) // Executing financial query
  ])
  .then(([totalProducts, totalSales, todayRevenue, lowStock, lowStockProducts, recentSales, todayProfit, financial]) => {
    // 👆 'financial' added to the arguments list
    
    res.render("layouts/dashboard", {
      user: req.session.user,
      active: "dashboard",
      totalProducts,
      totalSales,
      todayRevenue,
      lowStock,
      lowStockProducts,
      recentSales,
      todayProfit,
      // Pass these variables so EJS can find them
      totalReceivables: financial.totalReceivables || 0,
      totalPayables: financial.totalPayables || 0
    });
  })
  .catch(err => {
    console.error("Dashboard Error:", err);
    res.status(500).send("Internal Server Error");
  });
});
app.get("/inventory", isLoggedIn, (req, res) => {
  // Updated Query: Joins vendors table to get the 'name' as 'vendor_name'
  const inventoryQuery = `
    SELECT i.*, v.name as vendor_name 
    FROM inventory i 
    LEFT JOIN vendors v ON i.vendor_id = v.id 
    ORDER BY i.id DESC`;
  
  const vendorsQuery = "SELECT id, name FROM vendors ORDER BY name ASC";

  db.query(inventoryQuery, (err, inventoryResults) => {
    if (err) throw err;

    db.query(vendorsQuery, (err, vendorResults) => {
      if (err) throw err;

      const message = req.session.message || null;
      req.session.message = null;

      res.render("layouts/inventory", {
        user: req.session.user,
        items: inventoryResults, // Now contains 'vendor_name'
        vendors: vendorResults,
        active: "inventory",
        message
      });
    });
  });
});

app.post("/inventory/edit/:id", isLoggedIn, (req, res) => {
  // 1. Destructure using 'vendor_id' to match the form
  const { sku, name, category, price, cost_price, stock, vendor_id } = req.body; 

  const sql = `
    UPDATE inventory 
    SET sku=?, name=?, category=?, price=?, cost_price=?, stock=?, vendor_id=? 
    WHERE id=?
  `;

  // 2. Ensure vendor_id is passed to the query
  db.query(sql, [sku, name, category, price, cost_price, stock, vendor_id, req.params.id], (err) => {
    if (err) {
      console.error("Update Error:", err);
      return res.status(500).send("Internal Server Error");
    }
    res.redirect("/inventory");
  });
});

// app.get("/purchases", isLoggedIn, (req, res) => {
//     const purchaseSql = `
//         SELECT p.*, v.name as vendor_name 
//         FROM purchases p 
//         JOIN vendors v ON p.vendor_id = v.id 
//         ORDER BY p.id DESC`;

//     const vendorsSql = "SELECT id, name FROM vendors ORDER BY name ASC";

//     db.query(purchaseSql, (err, purchaseResults) => {
//         if (err) {
//             console.error("Purchase Query Error:", err);
//             return res.status(500).send("Database Error");
//         }

//         db.query(vendorsSql, (err, vendorResults) => {
//             if (err) throw err;

//             // CRITICAL: Must include 'layouts/' prefix
//             res.render("layouts/purchases", {
//                 user: req.session.user,
//                 purchases: purchaseResults,
//                 vendors: vendorResults,
//                 active: "purchases"
//             });
//         });
//     });
// });

// app.post("/purchases/add", isLoggedIn, (req, res) => {
//   const { vendor_id, items } = req.body; 
  
//   if (!items || items.length === 0) {
//     return res.status(400).json({ success: false, message: "No items provided" });
//   }

//   // Calculate total order amount
//   const total_amount = items.reduce((sum, item) => sum + (item.qty * item.cost_price), 0);

//   db.beginTransaction((err) => {
//     if (err) throw err;

//     // 1. Insert into main purchases table
//     const sqlPurchase = "INSERT INTO purchases (vendor_id, total_amount, purchase_date) VALUES (?, ?, CURDATE())";
//     db.query(sqlPurchase, [vendor_id, total_amount], (err, result) => {
//       if (err) return db.rollback(() => {
//   console.error("❌ Purchase DB Error:", err.message); // 👈 ADD THIS
//   res.status(500).json({ success: false, error: err.message });
// });
      
//       const purchaseId = result.insertId;

//       // --- NEW: Record in Ledger ---
//       const ledgerSql = `
//         INSERT INTO account_ledger 
//         (entity_type, entity_id, transaction_type, amount, description, reference_id) 
//         VALUES ('vendor', ?, 'credit', ?, ?, ?)`;
      
//       db.query(ledgerSql, [vendor_id, total_amount, 'Stock Purchase - Bulk', purchaseId], (err) => {
//         if (err) return db.rollback(() => { res.status(500).json({ success: false, error: err.message }); });

//         // 2. Loop through items to update Inventory and record Details
//         const queries = items.map(item => {
//           return new Promise((resolve, reject) => {
//             // Update Stock & Cost Price in Inventory
//             const updateStock = "UPDATE inventory SET stock = stock + ?, cost_price = ? WHERE id = ?";
//             db.query(updateStock, [item.qty, item.cost_price, item.product_id], (err) => {
//               if (err) return reject(err);
              
//               // Record this specific item in purchase history
//               const sqlItem = "INSERT INTO purchase_items (purchase_id, product_id, quantity, buy_price) VALUES (?, ?, ?, ?)";
//               db.query(sqlItem, [purchaseId, item.product_id, item.qty, item.cost_price], (err) => {
//                 if (err) return reject(err);
//                 resolve();
//               });
//             });
//           });
//         });

//         Promise.all(queries)
//           .then(() => {
//             db.commit((err) => {
//               if (err) return db.rollback(() => { throw err; });
//               res.json({ success: true, message: "Stock and Ledger updated successfully!" });
//             });
//           })
//           .catch(err => {
//             db.rollback(() => { res.status(500).json({ success: false, error: err.message }); });
//           });
//       }); // End of Ledger Query
//     });
//   });
// });

app.post("/ledger/add-payment", isLoggedIn, isAdmin, (req, res) => {
  const { entity_type, entity_id, amount, payment_method, description, transaction_type } = req.body;

  const finalAmount = parseFloat(amount) || 0;
  
  // Now using 'transaction_type' from the frontend selection
  const sql = `
    INSERT INTO account_ledger 
    (entity_type, entity_id, transaction_type, amount, description, payment_method) 
    VALUES (?, ?, ?, ?, ?, ?)`;

  db.query(sql, [
    entity_type,
    entity_id,
    transaction_type, // 'debit' or 'credit'
    finalAmount,
    description || 'Manual Payment',
    payment_method
  ], (err) => {
    if (err) {
      console.error("SQL Error:", err);
      return res.status(500).json({ success: false, error: "Database error occurred." });
    }
    res.json({ success: true });
  });
});

app.post("/inventory/add", (req, res) => {
  const { sku, name, category, price, cost_price, stock, vendor_id } = req.body; 
  const sql = "INSERT INTO inventory (sku, name, category, price, cost_price, stock, vendor_id) VALUES (?, ?, ?, ?, ?, ?, ?)";
  const v_id = vendor_id ? parseInt(vendor_id) : null;

  db.query(sql, [sku, name, category, price, cost_price, stock, v_id], (err) => {
    if (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(400).json({ success: false, message: `SKU '${sku}' already exists!` });
      }
      return res.status(500).json({ success: false, message: "Database error" });
    }
    res.json({ success: true, message: "Product added successfully" });
  });
});

app.get("/ledger/:type/:id", isLoggedIn, isAdmin, (req, res) => {
  const { type, id } = req.params;

  // Transaction list query
  const sql = `
    SELECT *, 
    SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE -amount END) 
    OVER (ORDER BY created_at, id) as running_balance
    FROM account_ledger 
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY created_at DESC`;

  // Totals query
  const totalSql = `
    SELECT 
      SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE 0 END) as totalDebit,
      SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END) as totalCredit
    FROM account_ledger 
    WHERE entity_type = ? AND entity_id = ?`;

  db.query(sql, [type, id], (err, transactions) => {
    db.query(totalSql, [type, id], (err, totals) => {
      res.render("layouts/ledger_view", {
        user: req.session.user,
        active: "ledger",
        transactions,
        type, id,
        totalDebit: totals[0].totalDebit || 0,
        totalCredit: totals[0].totalCredit || 0
      });
    });
  });
});

// -------- VENDORS PAGE --------
app.get("/vendors", isLoggedIn, (req, res) => {
  db.query("SELECT * FROM vendors ORDER BY id DESC", (err, results) => {
    if (err) throw err;
    
    res.render("layouts/vendors", {
      user: req.session.user,
      vendors: results,
      active: "vendors" // Matches the active check in header.ejs [cite: 36]
    });
  });
});

// ADD VENDOR POST
app.post("/vendors/add", isLoggedIn, (req, res) => {
  const { name, contact_person, phone, email, address } = req.body;
  const sql = "INSERT INTO vendors (name, contact_person, phone, email, address) VALUES (?, ?, ?, ?, ?)";
  
  db.query(sql, [name, contact_person, phone, email, address], (err) => {
    if (err) {
      console.error("Error adding vendor:", err);
      return res.status(500).send("Error adding vendor");
    }
    // Redirect back to the vendors list page
    res.redirect("/vendors");
  });
});

app.get("/sales", isLoggedIn, (req, res) => {
  db.query("SELECT * FROM sales ORDER BY id DESC", (err, results) => {
    if (err) throw err;

    res.render("layouts/sales", {
      user: req.session.user,
      orders: results,   // ✅ must be 'orders' to match sales.ejs
      active: "sales"
    });
  });
});
// ===== EXCEL IMPORT MODULE =====
// ===== EXCEL IMPORT MODULE =====
const multer = require("multer");
const ExcelJS = require("exceljs");
const fs = require("fs");

// Upload config
const upload = multer({ dest: "uploads/" });

// IMPORT PRODUCTS FROM EXCEL
app.post("/inventory/import", isLoggedIn, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      req.session.message = { type: "danger", text: "No file uploaded" };
      return res.redirect("/inventory");
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(req.file.path);

    const worksheet = workbook.worksheets[0];

    let promises = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const sku = row.getCell(1).value?.text || row.getCell(1).value;
      const name = row.getCell(2).value?.text || row.getCell(2).value;
      const category = row.getCell(3).value?.text || row.getCell(3).value;
      const price = row.getCell(4).value;
      const stock = row.getCell(5).value;

      if (!sku || !name) return;

      promises.push(new Promise((resolve) => {
        const sql = `
          INSERT INTO inventory (sku, name, category, price, stock)
          VALUES (?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
          name=VALUES(name),
          category=VALUES(category),
          price=VALUES(price),
          stock=VALUES(stock)
        `;

        db.query(sql, [sku, name, category, price, stock], (err) => {
          if (err) resolve(false);
          else resolve(true);
        });
      }));
    });

    const results = await Promise.all(promises);

    const successCount = results.filter(r => r).length;
    const errorCount = results.filter(r => !r).length;

    // 🔔 SET MESSAGE
    if (errorCount === 0) {
      req.session.message = {
        type: "success",
        text: `${successCount} products imported successfully`
      };
    } else {
      req.session.message = {
        type: "warning",
        text: `${successCount} imported, ${errorCount} failed`
      };
    }

    fs.unlinkSync(req.file.path);

    res.redirect("/inventory");

  } catch (err) {
    console.error(err);
    req.session.message = {
      type: "danger",
      text: "Import failed"
    };
    res.redirect("/inventory");
  }
});

function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  // If they are a cashier trying to access admin areas, block them
  res.status(403).send("Access Denied: You do not have permission to view this page.");
}
// GET: List all users (Admin Only)
app.get("/users", isLoggedIn, isAdmin, (req, res) => {
  db.query("SELECT id, username, Storename, role FROM admins ORDER BY id DESC", (err, results) => {
    if (err) throw err;
    res.render("layouts/users", {
      user: req.session.user,
      users: results,
      active: "users"
    });
  });
});

// POST: Add a new staff member
app.post("/users/add", isLoggedIn, isAdmin, (req, res) => {
  const { username, password, storename, role } = req.body;
  const sql = "INSERT INTO admins (username, password, Storename, role) VALUES (?, ?, ?, ?)";
  
  db.query(sql, [username, password, storename, role], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Error adding user");
    }
    res.redirect("/users");
  });
});

// GET: Delete a user
app.get("/users/delete/:id", isLoggedIn, isAdmin, (req, res) => {
  // Prevent admin from deleting themselves (safety check)
  if (parseInt(req.params.id) === req.session.user.id) {
    return res.send("You cannot delete your own account!");
  }
  
  db.query("DELETE FROM admins WHERE id = ?", [req.params.id], (err) => {
    if (err) throw err;
    res.redirect("/users");
  });
});
// app.get("/pos", isLoggedIn, (req, res) => {
//   db.query("SELECT * FROM inventory WHERE stock > 0", (err, products) => {
//     if (err) throw err;

//     res.render("layouts/pos", {
//       user: req.session.user,
//       products
//     });
//   });
// });


app.get("/pos", isLoggedIn, (req, res) => {
  db.query("SELECT * FROM inventory WHERE stock > 0", (err, products) => {
    if (err) throw err;

    db.query("SELECT * FROM customers ORDER BY id DESC", (err, customers) => {
      if (err) throw err;

      res.render("layouts/pos", {
        user: req.session.user,
        active: "pos",
        products,
        customers
      });
    });
  });
});

app.post("/pos/checkout", isLoggedIn, async (req, res) => {
  // 1. Destructure customer_id from the request body
  const { cart, paymentMethod, customer_id } = req.body; 
  let total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
  const invoiceNo = "INV-" + Date.now();

  db.beginTransaction(async (err) => {
    if (err) return res.status(500).json({ success: false, error: "Transaction Start Failed" });

    try {
      // --- STEP 1: Insert Sales Record ---
      const saleResult = await new Promise((resolve, reject) => {
        db.query(
          "INSERT INTO sales (invoice_no, total, payment_method) VALUES (?, ?, ?)",
          [invoiceNo, total, paymentMethod || 'Cash'],
          (err, result) => err ? reject(err) : resolve(result)
        );
      });

      const saleId = saleResult.insertId;

      // --- STEP 2: Process Items and Inventory ---
      for (const item of cart) {
        await new Promise((resolve, reject) => {
          db.query(
            "INSERT INTO sale_items (sale_id, product_id, quantity, price) VALUES (?, ?, ?, ?)",
            [saleId, item.id, item.qty, item.price],
            (err) => err ? reject(err) : resolve()
          );
        });

        await new Promise((resolve, reject) => {
          db.query(
            "UPDATE inventory SET stock = stock - ? WHERE id = ?",
            [item.qty, item.id],
            (err) => err ? reject(err) : resolve()
          );
        });
      }

      // --- STEP 3: NEW - Insert Ledger Entry ---
      // This records the financial movement for the customer
      await new Promise((resolve, reject) => {
        const ledgerSql = `
          INSERT INTO account_ledger 
          (entity_type, entity_id, transaction_type, amount, description, reference_id) 
          VALUES ('customer', ?, 'debit', ?, ?, ?)`;
        
        // Use customer_id if available, otherwise 0 for walk-in
        const cid = customer_id || 0; 
        const desc = `Sale - Invoice: ${invoiceNo}`;

        db.query(ledgerSql, [cid, total, desc, saleId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // --- STEP 4: Commit everything ---
      db.commit((err) => {
        if (err) throw err;
        res.json({ success: true, saleId });
      });

    } catch (error) {
      db.rollback(() => {
        console.error("Transaction Rollback due to:", error);
        res.status(500).json({ success: false, error: "Sale failed. Ledger and Stock were not changed." });
      });
    }
  });
});



app.post("/customers/add", isLoggedIn, (req, res) => {
  const { name, phone, gst_number } = req.body;

  const sql = "INSERT INTO customers (name, phone, gst_number) VALUES (?, ?, ?)";

  db.query(sql, [name, phone, gst_number || null], (err, result) => {
    if (err) return res.status(500).json({ success: false });

    res.json({
      success: true,
      customer: {
        id: result.insertId,
        name,
        phone,
        gst_number
      }
    });
  });
});

app.get("/invoice/:id", isLoggedIn, (req, res) => {
  const saleId = req.params.id;

  const saleQuery = "SELECT * FROM sales WHERE id = ?";
  const itemsQuery = `
    SELECT si.*, i.name 
    FROM sale_items si
    JOIN inventory i ON si.product_id = i.id
    WHERE si.sale_id = ?
  `;

  db.query(saleQuery, [saleId], (err, saleResult) => {
    if (err) throw err;

    db.query(itemsQuery, [saleId], (err, items) => {
      if (err) throw err;

      res.render("layouts/invoice", {
        user: req.session.user,
        sale: saleResult[0],
        items
      });
    });
  });
});

// purchase api

app.get("/users", isLoggedIn, isAdmin, (req, res) => {
  db.query("SELECT id, username, Storename, role FROM admins ORDER BY id DESC", (err, results) => {
    if (err) throw err;
    res.render("layouts/users", {
      user: req.session.user,
      users: results,
      active: "users"
    });
  });
});

// ================= AJAX PRODUCT REFRESH API =================
app.get("/inventory-data", isLoggedIn, (req, res) => {
    db.query("SELECT * FROM inventory WHERE stock > 0", (err, results) => {
        if (err) {
            console.error(err);
            return res.json([]);
        }
        res.json(results);
    });
});

// -------- LOGOUT --------
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.render("login", { error: null });
});


app.get("/ledger-list", isLoggedIn, isAdmin, (req, res) => {
  const customerSql = "SELECT id, name, 'customer' as type FROM customers";
  const vendorSql = "SELECT id, name, 'vendor' as type FROM vendors";

  db.query(customerSql, (err, customers) => {
    if (err) throw err;
    db.query(vendorSql, (err, vendors) => {
      if (err) throw err;
      res.render("layouts/ledger_list", {
        user: req.session.user,
        active: "ledger",
        accounts: [...customers, ...vendors] // Combine both for the list
      });
    });
  });
});

app.get("/ledger/:type/:id", isLoggedIn, isAdmin, (req, res) => {
  const { type, id } = req.params;

  // Query 1: Get Transactions & Running Balance
  const sql = `
    SELECT *, 
    SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE -amount END) 
    OVER (ORDER BY created_at, id) as running_balance
    FROM account_ledger 
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY created_at DESC`;

  // Query 2: Get Totals for Summary Cards
  const totalSql = `
    SELECT 
      SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE 0 END) as totalDebit,
      SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END) as totalCredit
    FROM account_ledger 
    WHERE entity_type = ? AND entity_id = ?`;

  db.query(sql, [type, id], (err, transactions) => {
    if (err) throw err;
    db.query(totalSql, [type, id], (err, totals) => {
      if (err) throw err;
      
      res.render("layouts/ledger_view", {
        user: req.session.user,
        active: "ledger",
        transactions,
        type,
        id,
        // Ensure values are numbers even if the DB returns NULL
        totalDebit: totals[0].totalDebit || 0,
        totalCredit: totals[0].totalCredit || 0
      });
    });
  });
});

// -------- Existing CRUD API (same as before) --------
// /users GET, POST, PUT, DELETE
// Keep your AJAX CRUD code as before

app.listen(3000, () => {
  console.log("🚀 Server running on http://localhost:3000");
});