// Load env first
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import snowflake from "snowflake-sdk";
import fetch from "node-fetch";
import cors from "cors";
import bodyParser from "body-parser";
import router from "./aiserver.js"; 

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// --- Snowflake connection setup ---
const connection = snowflake.createConnection({
  account: process.env.SF_ACCOUNT,
  username: process.env.SF_USER,
  password: process.env.SF_PASSWORD,
  warehouse: process.env.SF_WAREHOUSE,
  database: process.env.SF_DATABASE,
  schema: process.env.SF_SCHEMA,
});

// utility to run queries returning Promise<rows>
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sql,
      binds: params,
      complete: (err, stmt, rows) => {
        if (err) return reject(err);
        // rows comes from Snowflake driver
        resolve(rows || []);
      },
    });
  });
}

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
  } catch {}

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

// Patient details from cache
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

  const deliveryIds = deliveries.map((d) => d.DELIVERY_ID).filter((id) => id != null);
  const babies = unifiedCache.babies.filter((b) => deliveryIds.includes(b.DELIVERY_ID));

  const result = {
    patient: {
      PATIENT_ID: patient.PATIENT_ID,
      PATIENT_NAME: `${patient.FIRST_NAME || ""} ${patient.LAST_NAME || ""}`.trim(),
      AGE: patient.AGE,
      ADDRESS: patient.ADDRESS,
      CONTACT_NUMBER: patient.CONTACT_NUMBER,
      BLOOD_TYPE: patient.BLOOD_TYPE,
      SOURCE_SCHEMA: patient.SOURCE_SCHEMA,
    },
    visits,
    deliveries,
    babies,
    source: "cache",
    performance: "instant",
  };

  console.log(`✅ Patient data ready: ${visits.length} visits, ${deliveries.length} deliveries, ${babies.length} babies`);
  res.json(result);
});

// Get patients list (filter by SOURCE_SCHEMA)
app.get("/api/patients", (req, res) => {
  if (!unifiedCache.loaded) {
    return res.status(503).json({
      error: "Cache is still loading. Please wait...",
      loading: true,
    });
  }

  const schema = (req.query.schema || "ALL").toString().toUpperCase();
  console.log(`🔍 Filtering patients by SOURCE_SCHEMA: ${schema}`);

  let patientList;
  if (schema === "ALL") {
    patientList = unifiedCache.patients;
    console.log(`✅ Returning ALL patients (${patientList.length})`);
  } else {
    const matchingDeliveries = unifiedCache.deliveries.filter(
      (d) => (d.SOURCE_SCHEMA || "").toString().toUpperCase() === schema
    );
    const matchedPatientIds = new Set(matchingDeliveries.map((d) => d.PATIENT_ID));
    patientList = unifiedCache.patients.filter((p) => matchedPatientIds.has(p.PATIENT_ID));
    console.log(`✅ Returning ${patientList.length} patients for schema: ${schema}`);
  }

  const formattedPatients = (patientList || []).map((patient) => ({
    PATIENT_ID: patient.PATIENT_ID,
    PATIENT_NAME: `${patient.FIRST_NAME || ""} ${patient.LAST_NAME || ""}`.trim() || "Unknown Name",
    AGE: patient.AGE,
    ADDRESS: patient.ADDRESS,
    SOURCE_SCHEMA: patient.SOURCE_SCHEMA,
  }));

  res.json(formattedPatients);
});

// =======================
// 🩺 Ongoing Patients Endpoint (Single Schema)
// =======================
app.get("/api/ongoing-patients", (req, res) => {
  if (!unifiedCacheOngoing.loaded) {
    return res.status(503).json({
      error: "Ongoing patients cache is still loading. Please wait...",
      loading: true,
    });
  }

  const patientId = req.query.patientId
    ? Number(req.query.patientId)
    : null;

  let patientList = unifiedCacheOngoing.patients;

  // 🔍 Filter by patientId if provided
  if (patientId) {
    patientList = patientList.filter(
      (p) => Number(p.PATIENT_ID) === patientId
    );
    console.log(`✅ Returning ongoing patient with ID: ${patientId}`);
  } else {
    console.log(`✅ Returning all ongoing patients (${patientList.length})`);
  }

  // 🧩 Format the response
  const formattedPatients = patientList.map((p) => ({
    PATIENT_ID: p.PATIENT_ID,
    PATIENT_NAME:
      `${p.FIRST_NAME || ""} ${p.LAST_NAME || ""}`.trim() || "Unknown Name",
    AGE: p.AGE || "N/A",
    ADDRESS: p.ADDRESS || "N/A",
  }));

  res.json(formattedPatients);
});

// Test endpoint
app.get("/api/test", (req, res) => {
  res.json({
    message: "Snowflake connection successful!",
    cacheStatus: unifiedCache.loaded ? "loaded" : "loading",
  });
});

// Dashboard endpoint (example query) - keep consistent view names
app.get("/api/dashboard", (req, res) => {
  const query = `
    SELECT PATIENT_ID, CONCAT(FIRST_NAME,' ',LAST_NAME) AS PATIENT_NAME, ADDRESS
    FROM HEAL.HOSPITAL_VIEW.unified_patients_view
    LIMIT 10;
  `;

  connection.execute({
    sqlText: query,
    complete: (err, stmt, rows) => {
      if (err) {
        console.error("Error fetching data:", err);
        return res.status(500).json({ error: "Error fetching data" });
      }
      res.json(rows || []);
    },
  });
});

// =======================
// 🩺 Get Ongoing Patient Details by ID
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
    message: `✅ Found ${visits.length} visits for ongoing patient ID ${patientId}`,
  };

  res.json(response);
});

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

    // Corrected SQL query - use runQuery instead of executeQuery
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

    // Use runQuery (the function you defined) instead of executeQuery
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
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  console.log(`💾 Cache system enabled - data will load on startup`);
});