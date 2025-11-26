// Load env first
import dotenv from "dotenv";
dotenv.config();


import express from "express";
import snowflake from "snowflake-sdk";
import cors from "cors";
import bodyParser from "body-parser";


// ⭐️ Renamed 'aiserver 1.js' to 'aiserver.js'
import router from "./aiserver.js";

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// --- Snowflake connection setup ---
// ⭐️ Make sure your .env file has these new names
const connection = snowflake.createConnection({
    account: process.env.SF_ACCOUNT,
    username: process.env.SF_USER,
    password: process.env.SF_PASSWORD,
    warehouse: process.env.SF_WAREHOUSE,
    database: process.env.SF_DATABASE,
    schema: process.env.SF_SCHEMA,
});

// utility to run queries returning Promise<rows>
const runQuery = async (sql, params = []) => {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sql,
      binds: params, // This is crucial - binds the parameters
      complete: (err, stmt, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      }
    });
  });
};


// ====== Unified cache for delivered patients ======
let unifiedCache = {
    visits: [],
    patients: [],
    deliveries: [],
    babies: [],
    loaded: false,
    loading: false,
    error: null,
};


// ====== Unified cache for ongoing patients ======
let unifiedCacheOngoing = {
    visits: [],
    patients: [],
    loaded: false,
    loading: false,
    error: null,
};


// Load full hospital data
async function loadAllData() {
    if (unifiedCache.loading) return;
    unifiedCache.loading = true;
    console.log("🔄 Loading hospital data into cache...");

    try {
        const startTime = Date.now();
        // ⭐️ Make sure these view names match your Snowflake
        const [visits, patients, deliveries, babies] = await Promise.all([
            runQuery("SELECT * FROM HEAL.HOSPITAL_VIEW.unified_visits_view"),
            runQuery("SELECT * FROM HEAL.HOSPITAL_VIEW.unified_patients_view"),
            runQuery("SELECT * FROM HEAL.HOSPITAL_VIEW.unified_deliveries_view"),
            runQuery("SELECT * FROM HEAL.HOSPITAL_VIEW.unified_baby_view"),
        ]);

        unifiedCache.visits = visits || [];
        unifiedCache.patients = patients || [];
        unifiedCache.deliveries = deliveries || [];
        unifiedCache.babies = babies || [];
        unifiedCache.loaded = true;

        console.log(
            `✅ Main Cache Loaded: ${unifiedCache.patients.length} patients, ${unifiedCache.deliveries.length} deliveries`
        );
    } catch (err) {
        console.error("❌ Error loading main cache:", err);
        unifiedCache.error = err.message;
    } finally {
        unifiedCache.loading = false;
    }
}



// Load ongoing pregnancy data
async function loadOngoingData() {
    if (unifiedCacheOngoing.loading) return;
    unifiedCacheOngoing.loading = true;
    console.log("🔄 Loading ongoing patients data into cache...");

    try {
        const startTime = Date.now();
        // ⭐️ Make sure these table names match your Snowflake
        const [visits, patients] = await Promise.all([
            runQuery("SELECT * FROM HEAL.ONGOING.UNIFIED_VISITS_TABLE"),
            runQuery("SELECT * FROM HEAL.ONGOING.UNIFIED_PATIENTS_TABLE"),
        ]);

        unifiedCacheOngoing.visits = visits || [];
        unifiedCacheOngoing.patients = patients || [];
        unifiedCacheOngoing.loaded = true;

        const loadTime = Date.now() - startTime;
        console.log(`✅ Ongoing Cache Loaded in ${loadTime}ms`);
        console.log(
            `📊 Stats: ${unifiedCacheOngoing.patients.length} ongoing patients, ${unifiedCacheOngoing.visits.length} visits`
        );
    } catch (err) {
        console.error("❌ Error loading ongoing cache:", err);
        unifiedCacheOngoing.error = err.message;
    } finally {
        unifiedCacheOngoing.loading = false;
    }
}

// Connect once, then load both caches
connection.connect(async (err, conn) => {
    if (err) {
        console.error("❌ Unable to connect to Snowflake:", err.message);
        return;
    }

    console.log("✅ Connected to Snowflake!");
    try {
        console.log("Connection ID:", conn.getId());
    } catch { }

    // Load both caches
    await loadAllData();
    await loadOngoingData();
});




// ========== API endpoints ==========

// expose ai router
app.use("/api/ai", router);



// Cache status
app.get("/api/cache/status", (req, res) => {
    res.json({
        loaded: unifiedCache.loaded,
        loading: unifiedCache.loading,
        error: unifiedCache.error,
        stats: {
            patients: unifiedCache.patients.length,
            visits: unifiedCache.visits.length,
            deliveries: unifiedCache.deliveries.length,
            babies: unifiedCache.babies.length,
        },
    });
});

// Debug: first 10 patients
app.get("/api/debug/patients", (req, res) => {
    if (!unifiedCache.loaded) {
        return res.status(503).json({ error: "Cache not loaded" });
    }

    const firstTenPatients = unifiedCache.patients.slice(0, 10).map((p) => ({
        PATIENT_ID: p.PATIENT_ID,
        PATIENT_NAME: `${p.FIRST_NAME || ""} ${p.LAST_NAME || ""}`.trim(),
        SOURCE_SCHEMA: p.SOURCE_SCHEMA,
    }));

    res.json({
        message: "First 10 patients from cache:",
        patients: firstTenPatients,
        totalPatients: unifiedCache.patients.length,
    });
});

// Debug: search patients by name
app.get("/api/debug/search/:name", (req, res) => {
    if (!unifiedCache.loaded) {
        return res.status(503).json({ error: "Cache not loaded" });
    }

    const searchName = (req.params.name || "").toLowerCase();
    const foundPatients = unifiedCache.patients
        .filter((p) => {
            const fullName = `${p.FIRST_NAME || ""} ${p.LAST_NAME || ""}`.toLowerCase();
            return fullName.includes(searchName);
        })
        .slice(0, 10)
        .map((p) => ({
            PATIENT_ID: p.PATIENT_ID,
            PATIENT_NAME: `${p.FIRST_NAME || ""} ${p.LAST_NAME || ""}`.trim(),
            SOURCE_SCHEMA: p.SOURCE_SCHEMA,
        }));

    res.json({
        search: searchName,
        found: foundPatients.length,
        patients: foundPatients,
    });
});

// Manual reload
app.get("/api/cache/reload", async (req, res) => {
    try {
        await loadAllData();
        res.json({ message: "Cache reload triggered", status: "success" });
    } catch (err) {
        res.status(500).json({ message: "Reload failed", error: err?.message || String(err) });
    }
});

// Patient details from cache (for historical "Patient Details" page)
app.get("/api/patientDetails/:id", (req, res) => {
    const patientId = Number(req.params.id);
    if (Number.isNaN(patientId)) {
        return res.status(400).json({ error: "Invalid patient id" });
    }

    if (!unifiedCache.loaded) {
        return res.status(503).json({
            error: "Cache is still loading. Please try again in a few seconds.",
        });
    }

    console.log(`🔍 Fetching patient ${patientId} from cache...`);

    const patient = unifiedCache.patients.find((p) => Number(p.PATIENT_ID) === patientId);

    if (!patient) {
        return res.status(404).json({ error: "Patient not found" });
    }

    const visits = unifiedCache.visits.filter((v) => Number(v.PATIENT_ID) === patientId);
    const deliveries = unifiedCache.deliveries.filter((d) => Number(d.PATIENT_ID) === patientId);

    // ⭐️ This logic seems to find babies by delivery ID.
    const deliveryIds = deliveries.map((d) => d.PATIENT_ID).filter((id) => id != null);
    const babies = unifiedCache.babies.filter((b) => deliveryIds.includes(b.PATIENT_ID));

    const result = {
        patient: patient,
        visits,
        deliveries,
        babies,
        source: "cache",
    };

    console.log(`✅ Patient data ready: ${visits.length} visits, ${deliveries.length} deliveries, ${babies.length} babies`);
    res.json(result);
});

// Get patients list (for historical "Patient Details" page)
app.get("/api/patients", (req, res) => {
    if (!unifiedCache.loaded) {
        return res.status(503).json({
            error: "Cache is still loading. Please wait...",
            loading: true,
        });
    }

    // This just gets all patients. Your old code filtered by schema, but this seems simpler.
    let patientList = unifiedCache.patients;

    const formattedPatients = (patientList || []).map((patient) => ({
        PATIENT_ID: patient.PATIENT_ID,
        PATIENT_NAME: `${patient.FIRST_NAME || ""} ${patient.LAST_NAME || ""}`.trim() || "Unknown Name",
    }));

    res.json(formattedPatients);
});


// =======================
// 🩺 Ongoing Patients List (for "Ongoing Visits" page)
// =======================
app.get("/api/ongoing-patients", (req, res) => {
    if (!unifiedCacheOngoing.loaded) {
        return res.status(503).json({
            error: "Ongoing patients cache is still loading. Please wait...",
            loading: true,
        });
    }

    const patientList = unifiedCacheOngoing.patients;
    console.log(`✅ Returning all ongoing patients (${patientList.length})`);

    // 🧩 Format the response
    const formattedPatients = patientList.map((p) => ({
        PATIENT_ID: p.PATIENT_ID,
        PATIENT_NAME:
            `${p.FIRST_NAME || ""} ${p.LAST_NAME || ""}`.trim() || "Unknown Name",
    }));

    res.json(formattedPatients);
});


// =======================
// 🩺 Get Ongoing Patient Details by ID (for "Ongoing Visits" page)
// =======================
app.get("/api/ongoing-patientDetails/:id", (req, res) => {
    if (!unifiedCacheOngoing.loaded) {
        return res.status(503).json({
            error: "Ongoing patients cache is still loading. Please wait...",
            loading: true,
        });
    }

    const patientId = Number(req.params.id);
    if (!patientId) {
        return res.status(400).json({ error: "Invalid or missing patient ID" });
    }

    // 🔍 Find patient
    const patient = unifiedCacheOngoing.patients.find(
        (p) => Number(p.PATIENT_ID) === patientId
    );
    if (!patient) {
        return res.status(404).json({ error: `No ongoing patient found with ID ${patientId}` });
    }

    // 🔍 Find visits linked to this patient
    const visits = unifiedCacheOngoing.visits.filter(
        (v) => Number(v.PATIENT_ID) === patientId
    );

    // 🧩 Structure response
    const response = {
        patient,
        visits,
        // Add empty arrays so the React app doesn't crash
        deliveries: [],
        babies: [],
        message: `✅ Found ${visits.length} visits for ongoing patient ID ${patientId}`,
    };

    res.json(response);
});


// =======================
// 🩺 Home Page KPI Summary
// =======================
app.get("/api/home-summary", (req, res) => {
    console.log("📊 Home summary requested - Cache status:", {
        main: unifiedCache.loaded,
        ongoing: unifiedCacheOngoing.loaded
    });

    if (!unifiedCache.loaded || !unifiedCacheOngoing.loaded) {
        console.log("❌ Cache not ready yet");
        return res.status(503).json({
            success: false,
            error: "Cache is still loading. Please wait...",
            loading: true,
            cacheStatus: {
                main: unifiedCache.loaded,
                ongoing: unifiedCacheOngoing.loaded
            }
        });
    }

    try {
        // Safely access cache data with fallbacks
        const hospitalPatients = unifiedCache.patients || [];
        const ongoingPatients = unifiedCacheOngoing.patients || [];
        const deliveries = unifiedCache.deliveries || [];
        const babies = unifiedCache.babies || [];
        const hospitalVisits = unifiedCache.visits || [];
        const ongoingVisits = unifiedCacheOngoing.visits || [];

        console.log("📈 Data counts:", {
            hospitalPatients: hospitalPatients.length,
            ongoingPatients: ongoingPatients.length,
            deliveries: deliveries.length,
            babies: babies.length
        });

        // Calculate metrics
        const totalHospitalPatients = hospitalPatients.length;
        const totalOngoingPatients = ongoingPatients.length;
        const totalPatients = totalHospitalPatients + totalOngoingPatients;
        
        // Calculate delivery types
        let normalDeliveryCount = 0;
        let cSectionDeliveryCount = 0;
        
        deliveries.forEach(delivery => {
            const mode = delivery.DELIVERY_MODE?.toLowerCase();
            if (mode) {
                if (mode.includes('vaginal') || mode.includes('normal')) {
                    normalDeliveryCount++;
                } else if (mode.includes('c-section') || mode.includes('cesarean') || mode.includes('c_section')) {
                    cSectionDeliveryCount++;
                }
            }
        });
        
        const totalDeliveries = normalDeliveryCount + cSectionDeliveryCount;
        const totalBabies = babies.length;
        
        // Calculate today's appointments
        const today = new Date().toDateString();
        const todaysAppointments = 
            hospitalVisits.filter(v => v.VISIT_DATE && new Date(v.VISIT_DATE).toDateString() === today).length +
            ongoingVisits.filter(v => v.VISIT_DATE && new Date(v.VISIT_DATE).toDateString() === today).length;
        
        // Calculate delivery types from babies data or deliveries data
        let maturedCount = 0;
        let prematureCount = 0;
        let mortalityCount = 0;

        // Calculate from babies data
        babies.forEach(baby => {
            // Assuming SOURCE_SCHEMA indicates the delivery type
            if (baby.SOURCE_SCHEMA === 'MATURED') {
                maturedCount++;
            } else if (baby.SOURCE_SCHEMA === 'PREMATURE') {
                prematureCount++;
            } 
        });

         // Calculate mortality from patients data
        hospitalPatients.forEach(patient => {
            if (patient.SOURCE_SCHEMA === 'MORTALITY') {
                mortalityCount++;
            }
        });

        const totalBabiesWithType = maturedCount + prematureCount + mortalityCount;
        const maturedRate = totalBabiesWithType > 0 ? Math.round((maturedCount / totalBabiesWithType) * 100) : 0;
        const prematureRate = totalBabiesWithType > 0 ? Math.round((prematureCount / totalBabiesWithType) * 100) : 0;
        const mortalityRate = totalBabiesWithType > 0 ? Math.round((mortalityCount / totalBabiesWithType) * 100) : 0;

        const summary = {
            success: true,
            // Core Metrics
            totalPatients: totalPatients,
            activePregnancies: totalOngoingPatients,
            historicalPatients: totalHospitalPatients,
            
            // Delivery Analytics
            normalDeliveryCount: normalDeliveryCount,
            cSectionDeliveryCount: cSectionDeliveryCount,
            totalDeliveries: totalDeliveries,
            totalBabies: totalBabies,
            
            // Daily Operations
            todaysAppointments: todaysAppointments,
            
            // Calculated Ratios
            normalDeliveryRate: totalDeliveries > 0 ? Math.round((normalDeliveryCount / totalDeliveries) * 100) : 0,
            cSectionRate: totalDeliveries > 0 ? Math.round((cSectionDeliveryCount / totalDeliveries) * 100) : 0,

            // Delivery Types - Add this to your response
            deliveryTypes: {
                matured: maturedRate,
                premature: prematureRate,
                mortality: mortalityRate,
                maturedCount: maturedCount,
                prematureCount: prematureCount,
                mortalityCount: mortalityCount
            }
        };

        console.log("✅ Home Summary Generated:", summary);
        res.json(summary);
        
    } catch (err) {
        console.error("❌ Error in /api/home-summary:", err.message);
        res.status(500).json({ 
            success: false,
            error: "Failed to generate summary from cache",
            details: err.message 
        });
    }
});


// =======================
// 🩺 Reference Averages Endpoint
// =======================

app.post("/api/reference-averages", async (req, res) => {
  try {
    const { deliveryType, deliveryMode } = req.body;

    if (!deliveryType || !deliveryMode) {
      return res.status(400).json({
        success: false,
        error: "Missing deliveryType or deliveryMode in request body.",
      });
    }

    console.log(`📊 Fetching averages for ${deliveryType} + ${deliveryMode}`);

    // FIXED: Use parameterized query correctly
    const sql = `
      SELECT
        V.GESTATIONAL_AGE_WEEKS,
        ROUND(AVG(V.MATERNAL_WEIGHT), 2) AS AVG_WEIGHT,
        ROUND(AVG(V.FUNDAL_HEIGHT), 2) AS AVG_FUNDAL,
        ROUND(AVG(V.HEMOGLOBIN_LEVEL), 2) AS AVG_HB,
        ROUND(AVG(TRY_CAST(SPLIT_PART(V.BLOOD_PRESSURE, '/', 1) AS FLOAT))) AS AVG_SYSTOLIC,
        ROUND(AVG(TRY_CAST(SPLIT_PART(V.BLOOD_PRESSURE, '/', 2) AS FLOAT))) AS AVG_DIASTOLIC,
        ROUND(AVG(V.FETAL_HEART_RATE), 2) AS AVG_FHR
      FROM HEAL.HOSPITAL_VIEW.UNIFIED_VISITS_VIEW V
      JOIN HEAL.HOSPITAL_VIEW.UNIFIED_DELIVERIES_VIEW D
        ON V.PATIENT_ID = D.PATIENT_ID
      WHERE 
        LOWER(D.SOURCE_SCHEMA) = LOWER(?)
        AND LOWER(D.DELIVERY_MODE) = LOWER(?)
      GROUP BY V.GESTATIONAL_AGE_WEEKS
      ORDER BY V.GESTATIONAL_AGE_WEEKS ASC
    `;

    // FIXED: Use the correct parameter format for Snowflake
    const rows = await runQuery(sql, [deliveryType, deliveryMode]);

    if (!rows || rows.length === 0) {
      return res.json({
        success: true,
        deliveryType,
        deliveryMode,
        averages: {},
        message: "No matching records found for this category.",
      });
    }

    // ✅ Format data for frontend charts
    const averages = {
      maternal_weight: [],
      fundal_height: [],
      hb: [],
      systolic: [],
      diastolic: [],
      fetal_hr: [],
    };

    rows.forEach((r) => {
      const week = Number(r.GESTATIONAL_AGE_WEEKS);
      
      // Handle null/undefined values with proper fallbacks
      averages.maternal_weight.push({ 
        week, 
        value: r.AVG_WEIGHT ? Number(r.AVG_WEIGHT) : 0 
      });
      
      averages.fundal_height.push({ 
        week, 
        value: r.AVG_FUNDAL ? Number(r.AVG_FUNDAL) : 0 
      });
      
      averages.hb.push({ 
        week, 
        value: r.AVG_HB ? Number(r.AVG_HB) : 0 
      });
      
      averages.systolic.push({ 
        week, 
        value: r.AVG_SYSTOLIC ? Math.round(r.AVG_SYSTOLIC) : 0 
      });
      
      averages.diastolic.push({ 
        week, 
        value: r.AVG_DIASTOLIC ? Math.round(r.AVG_DIASTOLIC) : 0 
      });
      
      averages.fetal_hr.push({ 
        week, 
        value: r.AVG_FHR ? Math.round(r.AVG_FHR) : 0 
      });
    });

    // ✅ Respond to frontend
    res.json({
      success: true,
      deliveryType,
      deliveryMode,
      totalWeeks: rows.length,
      averages,
      generatedAt: new Date().toISOString(),
    });

  } catch (error) {
    console.error("❌ Reference average error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch reference averages.",
      details: error.message,
      sqlState: error.sqlState,
      code: error.code
    });
  }
});


// Debug endpoint to check cache status
app.get("/api/debug-cache", (req, res) => {
    const cacheStatus = {
        unifiedCache: {
            loaded: unifiedCache.loaded,
            loading: unifiedCache.loading,
            patients: unifiedCache.patients?.length || 0,
            deliveries: unifiedCache.deliveries?.length || 0,
            babies: unifiedCache.babies?.length || 0,
            visits: unifiedCache.visits?.length || 0
        },
        unifiedCacheOngoing: {
            loaded: unifiedCacheOngoing.loaded,
            loading: unifiedCacheOngoing.loading,
            patients: unifiedCacheOngoing.patients?.length || 0,
            visits: unifiedCacheOngoing.visits?.length || 0
        },
        timestamp: new Date().toISOString()
    };
    
    console.log("🔍 Cache Debug Info:", cacheStatus);
    res.json(cacheStatus);
});



// =======================
// 🏥 Get Unique Patient Addresses
// =======================
app.get("/api/patient-addresses", (req, res) => {
    if (!unifiedCache.loaded) {
        return res.status(503).json({
            error: "Cache is still loading. Please wait...",
            loading: true,
        });
    }

    try {
        // Extract unique addresses from patients data
        const addresses = unifiedCache.patients
            .map(p => p.ADDRESS)
            .filter(address => address && address.trim() !== '') // Remove empty addresses
            .filter((address, index, self) => self.indexOf(address) === index) // Get unique addresses
            .sort(); // Sort alphabetically

        // Add "All Locations" option
        const addressOptions = [
            { value: 'all', label: 'All Locations' },
            ...addresses.map(address => ({
                value: address,
                label: address
            }))
        ];

        console.log(`✅ Found ${addresses.length} unique patient addresses`);
        
        res.json({
            success: true,
            addresses: addressOptions
        });
    } catch (err) {
        console.error("❌ Error fetching patient addresses:", err);
        res.status(500).json({
            success: false,
            error: "Failed to fetch patient addresses"
        });
    }
});

// =======================
// 🏥 Get Filtered Home Summary by Address
// =======================
app.get("/api/home-summary-filtered", (req, res) => {
    const address = req.query.address;
    
    if (!unifiedCache.loaded) {
        return res.status(503).json({
            error: "Cache is still loading. Please wait...",
            loading: true,
        });
    }

    try {
        let filteredPatients = unifiedCache.patients;
        let filteredVisits = unifiedCache.visits;
        let filteredDeliveries = unifiedCache.deliveries;
        let filteredBabies = unifiedCache.babies;

        // Filter by address if provided and not 'all'
        if (address && address !== 'all') {
            filteredPatients = unifiedCache.patients.filter(p => 
                p.ADDRESS && p.ADDRESS === address
            );
            
            const filteredPatientIds = filteredPatients.map(p => p.PATIENT_ID);
            
            filteredVisits = unifiedCache.visits.filter(v => 
                filteredPatientIds.includes(v.PATIENT_ID)
            );
            filteredDeliveries = unifiedCache.deliveries.filter(d => 
                filteredPatientIds.includes(d.PATIENT_ID)
            );
            filteredBabies = unifiedCache.babies.filter(b => 
                filteredPatientIds.includes(b.PATIENT_ID)
            );
        }

        // Calculate metrics with filtered data
        const hospitalPatients = filteredPatients || [];
        const ongoingPatients = unifiedCacheOngoing.patients || []; // Ongoing patients remain unfiltered for now
        const deliveries = filteredDeliveries || [];
        const babies = filteredBabies || [];
        const hospitalVisits = filteredVisits || [];
        const ongoingVisits = unifiedCacheOngoing.visits || [];

        // Your existing calculation logic here...
        const totalHospitalPatients = hospitalPatients.length;
        const totalOngoingPatients = ongoingPatients.length;
        const totalPatients = totalHospitalPatients + totalOngoingPatients;
        
        // Calculate delivery types
        let normalDeliveryCount = 0;
        let cSectionDeliveryCount = 0;
        
        deliveries.forEach(delivery => {
            const mode = delivery.DELIVERY_MODE?.toLowerCase();
            if (mode) {
                if (mode.includes('vaginal') || mode.includes('normal')) {
                    normalDeliveryCount++;
                } else if (mode.includes('c-section') || mode.includes('cesarean') || mode.includes('c_section')) {
                    cSectionDeliveryCount++;
                }
            }
        });
        
        const totalDeliveries = normalDeliveryCount + cSectionDeliveryCount;
        const totalBabies = babies.length;
        
        // Calculate today's appointments
        const today = new Date().toDateString();
        const todaysAppointments = 
            hospitalVisits.filter(v => v.VISIT_DATE && new Date(v.VISIT_DATE).toDateString() === today).length +
            ongoingVisits.filter(v => v.VISIT_DATE && new Date(v.VISIT_DATE).toDateString() === today).length;
        
        // Calculate delivery types from babies data
        let maturedCount = 0;
        let prematureCount = 0;
        let mortalityCount = 0;

        babies.forEach(baby => {
            if (baby.SOURCE_SCHEMA === 'MATURED') {
                maturedCount++;
            } else if (baby.SOURCE_SCHEMA === 'PREMATURE') {
                prematureCount++;
            } 
        });

        hospitalPatients.forEach(patient => {
            if (patient.SOURCE_SCHEMA === 'MORTALITY') {
                mortalityCount++;
            }
        });

        const totalBabiesWithType = maturedCount + prematureCount + mortalityCount;
        const maturedRate = totalBabiesWithType > 0 ? Math.round((maturedCount / totalBabiesWithType) * 100) : 0;
        const prematureRate = totalBabiesWithType > 0 ? Math.round((prematureCount / totalBabiesWithType) * 100) : 0;
        const mortalityRate = totalBabiesWithType > 0 ? Math.round((mortalityCount / totalBabiesWithType) * 100) : 0;

        const summary = {
            success: true,
            // Core Metrics
            totalPatients: totalPatients,
            activePregnancies: totalOngoingPatients,
            historicalPatients: totalHospitalPatients,
            
            // Delivery Analytics
            normalDeliveryCount: normalDeliveryCount,
            cSectionDeliveryCount: cSectionDeliveryCount,
            totalDeliveries: totalDeliveries,
            totalBabies: totalBabies,
            
            // Daily Operations
            todaysAppointments: todaysAppointments,
            
            // Calculated Ratios
            normalDeliveryRate: totalDeliveries > 0 ? Math.round((normalDeliveryCount / totalDeliveries) * 100) : 0,
            cSectionRate: totalDeliveries > 0 ? Math.round((cSectionDeliveryCount / totalDeliveries) * 100) : 0,

            // Delivery Types
            deliveryTypes: {
                matured: maturedRate,
                premature: prematureRate,
                mortality: mortalityRate,
                maturedCount: maturedCount,
                prematureCount: prematureCount,
                mortalityCount: mortalityCount
            },

            // Filter info
            filter: {
                address: address,
                patientCount: hospitalPatients.length
            }
        };

        console.log(`✅ Filtered Home Summary: ${hospitalPatients.length} patients for address "${address}"`);
        res.json(summary);
        
    } catch (err) {
        console.error("❌ Error in /api/home-summary-filtered:", err.message);
        res.status(500).json({ 
            success: false,
            error: "Failed to generate filtered summary",
            details: err.message 
        });
    }
});






// Start server
app.listen(port, () => {
    console.log(`🚀 Server running at http://localhost:${port}`);
    console.log(`💾 Cache system enabled - data will load on startup`);
});

