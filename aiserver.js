import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();
const router = express.Router();

// ✅ Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ===============================
// 🤖 AI: Delivery Insight Endpoint
// ===============================
router.post("/insight", async (req, res) => {
  try {
    const { visits = [], patient = {}, deliveries = [], babies = [] } = req.body;

    if (!Array.isArray(visits) || visits.length === 0) {
      return res.status(400).json({ success: false, error: "No visit data provided" });
    }

    const latestVisit = visits.at(-1);
    const latestDelivery = deliveries.at(-1) || {};
    const latestBaby = babies.at(-1) || {};

    const prompt = `
You are an experienced **maternal health AI specialist**.
Analyze this delivery data and provide:
1. Why this delivery type (Normal / C-section / Premature / Mortality) occurred.
2. Predict mother and baby recovery / risks.
3. Provide a concise medical-style summary.

**PATIENT SUMMARY**
- Name: ${patient?.FIRST_NAME || "Unknown"} ${patient?.LAST_NAME || ""}
- Age: ${patient?.DATE_OF_BIRTH || "Unknown"}
- BMI: ${patient?.BMI_VALUE || "Unknown"} (${patient?.BMI_STATUS || "N/A"})
- Gravida/Parity: G${patient?.GRAVIDA || "?"}, P${patient?.PARITY || "?"}
- Medical History: ${patient?.MEDICAL_HISTORY || "None"}
- Blood Type: ${patient?.BLOOD_TYPE || "Unknown"}

**DELIVERY DETAILS**
- Mode: ${latestDelivery?.DELIVERY_MODE || "Unknown"}
- GA at Delivery: ${latestDelivery?.GESTATIONAL_AGE_AT_DELIVERY || "Unknown"} weeks
- Complications: ${latestDelivery?.DELIVERY_COMPLICATIONS || "None"}
- Post-Delivery Condition: ${latestDelivery?.MOTHER_CONDITION_POST_DELIVERY || "Unknown"}
- Stay: ${latestDelivery?.LENGTH_OF_STAY || "Unknown"} days

**BABY**
- Sex: ${latestBaby?.BABY_SEX || "Unknown"}
- Weight: ${latestBaby?.BIRTH_WEIGHT || "Unknown"} kg
- APGAR: ${latestBaby?.APGAR_SCORE_1MIN || "?"} (1m), ${latestBaby?.APGAR_SCORE_5MIN || "?"} (5m)
- NICU: ${latestBaby?.NICU_ADMISSION || "Unknown"}
- Complications: ${latestBaby?.NEONATAL_COMPLICATIONS || "None"}

**LATEST VISIT**
- GA: ${latestVisit?.GESTATIONAL_AGE_WEEKS || "N/A"} weeks
- BP: ${latestVisit?.BLOOD_PRESSURE || "N/A"}
- Hb: ${latestVisit?.HEMOGLOBIN_LEVEL || "N/A"} g/dL
- Fundal Height: ${latestVisit?.FUNDAL_HEIGHT || "N/A"} cm
- Complications: ${latestVisit?.COMPLICATIONS || "None"}

Provide:
- Why this delivery type occurred  
- Mother prognosis  
- Baby prognosis  
- One-line summary
`;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.() || "⚠️ No response from Gemini.";

    res.json({ success: true, source: "gemini", insight: text.trim() });
  } catch (error) {
    console.error("❌ AI Insight Error:", error);
    res.status(500).json({ success: false, error: "Failed to generate AI insight" });
  }
});

// ===============================
// 🤖 AI: Ongoing Pregnancy Insight
// ===============================
router.post("/ongoing-insight", async (req, res) => {
  try {
    const { visits = [], patient = {} } = req.body;

    if (!Array.isArray(visits) || visits.length === 0) {
      return res.status(400).json({ success: false, error: "No visit data provided." });
    }

    const visitSummary = visits
      .map(
        (v, i) => `
Visit ${i + 1}:
- GA: ${v.GESTATIONAL_AGE_WEEKS || "N/A"} weeks
- BP: ${v.BLOOD_PRESSURE || "N/A"}
- Hb: ${v.HEMOGLOBIN_LEVEL || "N/A"} g/dL
- Fundal Height: ${v.FUNDAL_HEIGHT || "N/A"} cm
- Weight: ${v.MATERNAL_WEIGHT || "N/A"} kg
- Complications: ${v.COMPLICATIONS || "None"}`
      )
      .join("\n");

    const prompt = `
You are an **AI obstetric health specialist** monitoring pregnancy.
Analyze full history and predict:
1. Delivery type (Normal / C-section / Premature / Risk)
2. Risks or warning signs
3. Precautions for upcoming weeks
4. One-line summary with advice.

**PATIENT SUMMARY**
${JSON.stringify(patient, null, 2)}

**VISIT HISTORY**
${visitSummary}
`;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.() || "⚠️ No AI response.";

    res.json({ success: true, source: "gemini", insight: text.trim() });
  } catch (error) {
    console.error("❌ Ongoing Insight Error:", error);
    res.status(500).json({ success: false, error: "Failed to generate ongoing insight." });
  }
});

// ===============================
// 🤖 AI + Rule-Based Progression Prediction
// ===============================
router.post("/ongoing-progression", async (req, res) => {
  try {
    const { visits = [], patient = {} } = req.body;

    console.log("🎯 RULE-BASED PREDICTION ENGINE");
    console.log("Patient ID:", patient.PATIENT_ID || "Unknown");
    console.log("Total Visits:", visits.length);

    const prediction = generateRuleBasedPrediction(visits, patient);
    console.log("✅ Prediction:", prediction.summary);

    res.json({ success: true, ...prediction });
  } catch (error) {
    console.error("❌ Prediction error:", error);
    const fallback = getFallbackPrediction();
    res.json({ success: true, ...fallback, error: error.message });
  }
});

// ===============================
// 🧩 Rule-Based Prediction Engine
// ===============================
function generateRuleBasedPrediction(visits, patient) {
  const validatedVisits = (visits || [])
    .filter((v) => v && v.GESTATIONAL_AGE_WEEKS)
    .sort((a, b) => a.GESTATIONAL_AGE_WEEKS - b.GESTATIONAL_AGE_WEEKS);

  if (!validatedVisits.length) return getFallbackPrediction();

  const latestVisit = validatedVisits.at(-1);
  const currentGA = latestVisit.GESTATIONAL_AGE_WEEKS;
  const weeksToProject = Math.min(40 - currentGA, 12);

  const riskScore = calculatePatientRisk(latestVisit, patient, validatedVisits);
  const deliveryType = calculateDeliveryType(riskScore);
  const deliveryMode = calculateDeliveryMode(riskScore);
  const progression = generateProgression(validatedVisits, currentGA, weeksToProject);
  const summary = generateSummary(riskScore, deliveryType, patient, latestVisit);

  return {
    deliveryType,
    deliveryMode,
    progression,
    summary,
    metadata: {
      currentGestationalAge: currentGA,
      weeksProjected: weeksToProject,
      visitCount: validatedVisits.length,
      riskScore: Math.round(riskScore * 100) / 100,
      generatedAt: new Date().toISOString(),
      source: "rule-based-engine",
    },
  };
}

// ============ Supporting Functions ============
function calculatePatientRisk(visit, patient, allVisits) {
  let risk = 0;
  const age = patient.AGE || 25;
  const bmi = patient.BMI_VALUE || 23;

  if (visit.HEMOGLOBIN_LEVEL < 11) risk += 0.3;
  if (visit.HEMOGLOBIN_LEVEL < 10) risk += 0.2;
  if (visit.BLOOD_PRESSURE) {
    const { systolic, diastolic } = parseBloodPressure(visit.BLOOD_PRESSURE);
    if (systolic >= 140 || diastolic >= 90) risk += 0.4;
  }
  if (visit.FUNDAL_HEIGHT && Math.abs(visit.FUNDAL_HEIGHT - visit.GESTATIONAL_AGE_WEEKS) > 3)
    risk += 0.2;
  if (age < 18 || age > 35) risk += 0.2;
  if (bmi < 18.5 || bmi > 30) risk += 0.2;
  return Math.min(1, risk);
}

function calculateDeliveryType(risk) {
  const ft = 0.8 - risk * 0.4;
  const pm = 0.15 + risk * 0.3;
  const mr = 0.05 + risk * 0.1;
  const sum = ft + pm + mr;
  return {
    Matured: +(ft / sum).toFixed(2),
    Premature: +(pm / sum).toFixed(2),
    MortalityRisk: +(mr / sum).toFixed(2),
  };
}

function calculateDeliveryMode(risk) {
  const c = Math.min(0.6, risk * 0.8);
  return { Normal: +(1 - c).toFixed(2), CSection: +c.toFixed(2) };
}

function generateProgression(visits, currentGA, weeksToProject) {
  const v = visits.at(-1);
  const bp = parseBloodPressure(v.BLOOD_PRESSURE);
  const base = {
    w: v.MATERNAL_WEIGHT || 62,
    h: v.HEMOGLOBIN_LEVEL || 11.5,
    f: v.FUNDAL_HEIGHT || currentGA,
    fhr: v.FETAL_HEART_RATE || 145,
  };

  const progression = { weight: [], fundal: [], hb: [], systolic: [], diastolic: [], fetal_hr: [] };
  for (let i = 1; i <= weeksToProject; i++) {
    const week = currentGA + i;
    progression.weight.push({ week, value: +(base.w + i * 0.4).toFixed(1) });
    progression.fundal.push({ week, value: +(week + (Math.random() * 2 - 1)).toFixed(1) });
    progression.hb.push({ week, value: +(base.h - i * 0.04).toFixed(1) });
    progression.systolic.push({ week, value: bp.systolic + i * 0.5 });
    progression.diastolic.push({ week, value: bp.diastolic + i * 0.3 });
    progression.fetal_hr.push({ week, value: base.fhr + (Math.random() * 6 - 3) });
  }
  return progression;
}

function parseBloodPressure(bp) {
  try {
    const [s, d] = bp.toString().split("/").map(Number);
    return { systolic: s || 115, diastolic: d || 70 };
  } catch {
    return { systolic: 115, diastolic: 70 };
  }
}

function generateSummary(risk, deliveryType, patient, visit) {
  const ft = Math.round(deliveryType.Matured * 100);
  if (risk < 0.3)
    return `Low-risk pregnancy (${ft}% MATURED). Continue standard antenatal monitoring.`;
  if (risk < 0.6)
    return `Moderate risk (${ft}% MATURED). Monitor blood pressure and hemoglobin weekly.`;
  return `High-risk pregnancy (${ft}% MATURED). Close supervision and referral recommended.`;
}

function getFallbackPrediction() {
  return {
    deliveryType: { Matured: 0.75, Premature: 0.2, MortalityRisk: 0.05 },
    deliveryMode: { Normal: 0.65, CSection: 0.35 },
    progression: { weight: [], fundal: [], hb: [], systolic: [], diastolic: [], fetal_hr: [] },
    summary: "Standard pregnancy progression model applied.",
    isFallback: true,
  };
}




// ===========================
// 🥗 AI Diet Recommendation
// ===========================
router.post("/diet-plan", async (req, res) => {
  try {
    const { patient = {}, visits = [] } = req.body;
    const latestVisit = visits[visits.length - 1] || {};

    const prompt = `
You are a certified maternal nutrition specialist AI.
Create a **7-day personalized diet plan** for a pregnant woman based on her health data.

---

**PATIENT PROFILE**
- Age: ${patient.AGE || "N/A"}
- BMI: ${patient.BMI_VALUE || "N/A"} (${patient.BMI_STATUS || "Unknown"})
- Gestational Age: ${latestVisit.GESTATIONAL_AGE_WEEKS || "N/A"} weeks
- Hemoglobin Level: ${latestVisit.HEMOGLOBIN_LEVEL || "N/A"} g/dL
- Blood Pressure: ${latestVisit.BLOOD_PRESSURE || "N/A"}
- Complications: ${latestVisit.COMPLICATIONS || "None"}
- Medical History: ${patient.MEDICAL_HISTORY || "None"}
- Food Preferences: ${patient.DIET_TYPE || "Not specified"} (e.g., Veg / Non-veg)

---

**TASKS**
1. Recommend a **daily diet plan (Breakfast, Lunch, Snack, Dinner)** for 7 days.  
2. Include **protein, iron, calcium, and hydration** suggestions.  
3. If anemic or low BMI → focus on iron & calorie-rich foods.  
4. Keep meals realistic for Indian households.  
5. Provide a **short nutritional tip summary** at the end.

**Example Output (structured text):**
Day 1:
- Breakfast: Oats with milk & banana  
- Lunch: Brown rice, dal, spinach curry  
- Snack: Roasted chana + lemon water  
- Dinner: Chapati, paneer curry, salad  
Tip: Stay hydrated and include citrus fruits for iron absorption. and dont say ok this is your like don't want just directly tell that
`;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.() || "⚠️ No AI response";

    res.json({ success: true, source: "gemini", dietPlan: text.trim() });
  } catch (error) {
    console.error("❌ Diet Plan Error:", error);
    res.status(500).json({ success: false, error: "Failed to generate diet plan" });
  }
});





// ===========================
// 🧘‍♀️ AI Exercise & Wellness Plan
// ===========================
router.post("/exercise-plan", async (req, res) => {
  try {
    const { patient = {}, visits = [] } = req.body;
    const latestVisit = visits[visits.length - 1] || {};

    const prompt = `
You are an AI maternal fitness coach.
Create a **safe weekly exercise & lifestyle plan** for a pregnant woman based on her health profile.

---

**PATIENT PROFILE**
- Age: ${patient.AGE || "N/A"}
- Gestational Age: ${latestVisit.GESTATIONAL_AGE_WEEKS || "N/A"} weeks
- BMI: ${patient.BMI_VALUE || "N/A"} (${patient.BMI_STATUS || "Unknown"})
- Blood Pressure: ${latestVisit.BLOOD_PRESSURE || "N/A"}
- Hemoglobin: ${latestVisit.HEMOGLOBIN_LEVEL || "N/A"} g/dL
- Complications: ${latestVisit.COMPLICATIONS || "None"}
- Previous Pregnancy: G${patient.GRAVIDA || "?"}, P${patient.PARITY || "?"}
- Activity Level: ${patient.ACTIVITY_LEVEL || "Moderate"}

---

**TASKS**
1. Recommend safe **daily exercises or activities** (walking, stretching, yoga, breathing, etc.).  
2. Include **precautions** (e.g., avoid lying flat after 20 weeks, avoid lifting heavy).  
3. Add **1-2 mindfulness or relaxation suggestions**.  
4. End with a short **summary paragraph** of overall advice.

**Example Output (structured text):**
Day 1: 20 min brisk walk + 10 min pelvic floor stretch  
Day 2: Prenatal yoga + breathing  
Day 3: Light household activity, rest in the afternoon  
Precautions: Avoid supine position after 20 weeks.  
Tip: Consistency > intensity. Gentle movement helps reduce swelling & improve sleep.
 and dont say ok this is your like dont wan't just directly tell that

`;

    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const text = result?.response?.text?.() || "⚠️ No AI response";

    res.json({ success: true, source: "gemini", exercisePlan: text.trim() });
  } catch (error) {
    console.error("❌ Exercise Plan Error:", error);
    res.status(500).json({ success: false, error: "Failed to generate exercise plan" });
  }
});















// ===============================
// 🔍 Test Gemini Connectivity
// ===============================
router.get("/testInsight", async (req, res) => {
  try {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_API_URL =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

    if (!GEMINI_API_KEY)
      return res.status(500).json({ success: false, error: "Missing GEMINI_API_KEY" });

    const prompt = `
You are a maternal health AI assistant.
Patient:
- Age: 27
- BMI: 23.5
- BP: 118/75
- Hb: 11.8 g/dL
- GA: 34 weeks
Predict delivery type, mother & baby condition, and one recommendation.`;

    const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      }),
    });

    const result = await response.json();
    const text =
      result?.candidates?.[0]?.content?.parts?.[0]?.text ||
      JSON.stringify(result, null, 2);

    res.json({ success: true, source: "gemini", insight: text });
  } catch (error) {
    console.error("❌ Test Insight Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
















