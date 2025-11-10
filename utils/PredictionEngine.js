// utils/PredictionEngine.js

class PredictionEngine {
  constructor(visits, patient) {
    this.visits = visits || [];
    this.patient = patient || {};
    this.validatedVisits = this.validateVisits(this.visits);
  }

  validateVisits(visits) {
    if (!visits || !Array.isArray(visits)) return [];
    
    return visits
      .map(visit => ({
        GESTATIONAL_AGE_WEEKS: visit.GESTATIONAL_AGE_WEEKS || null,
        MATERNAL_WEIGHT: visit.MATERNAL_WEIGHT || null,
        FUNDAL_HEIGHT: visit.FUNDAL_HEIGHT || null,
        HEMOGLOBIN_LEVEL: visit.HEMOGLOBIN_LEVEL || null,
        BLOOD_PRESSURE: visit.BLOOD_PRESSURE || null,
        FETAL_HEART_RATE: visit.FETAL_HEART_RATE || null,
        COMPLICATIONS: visit.COMPLICATIONS || null,
        VISIT_DATE: visit.VISIT_DATE || null
      }))
      .filter(visit => visit.GESTATIONAL_AGE_WEEKS && visit.GESTATIONAL_AGE_WEEKS > 0);
  }

  generatePrediction() {
    if (this.validatedVisits.length === 0) {
      return this.getFallbackPrediction();
    }

    const currentGA = Math.max(...this.validatedVisits.map(v => v.GESTATIONAL_AGE_WEEKS));
    const weeksToProject = Math.min(40 - currentGA, 12);

    if (weeksToProject <= 0) {
      return this.getFallbackPrediction();
    }

    const riskScores = this.calculateRiskScores();
    const deliveryType = this.calculateDeliveryTypeProbabilities(riskScores);
    const deliveryMode = this.calculateDeliveryModeProbabilities(riskScores);
    const progression = this.generateProgression(currentGA, weeksToProject);
    const summary = this.generateSummary(riskScores, deliveryType, deliveryMode);

    return {
      deliveryType,
      deliveryMode,
      progression,
      summary,
      metadata: {
        currentGestationalAge: currentGA,
        weeksProjected: weeksToProject,
        visitCount: this.validatedVisits.length,
        riskScores,
        generatedAt: new Date().toISOString(),
        source: "rule-based-engine"
      }
    };
  }

  calculateRiskScores() {
    const latestVisit = this.validatedVisits[this.validatedVisits.length - 1];
    const scores = {
      anemia: 0,
      hypertension: 0,
      growthRestriction: 0,
      pretermRisk: 0,
      maternalAgeRisk: 0,
      bmiRisk: 0
    };

    // Anemia Risk
    if (latestVisit.HEMOGLOBIN_LEVEL) {
      if (latestVisit.HEMOGLOBIN_LEVEL < 10) scores.anemia = 0.8;
      else if (latestVisit.HEMOGLOBIN_LEVEL < 11) scores.anemia = 0.4;
      else scores.anemia = 0.1;
    }

    // Hypertension Risk
    if (latestVisit.BLOOD_PRESSURE) {
      const bp = this.parseBloodPressure(latestVisit.BLOOD_PRESSURE);
      if (bp.systolic >= 140 || bp.diastolic >= 90) scores.hypertension = 0.9;
      else if (bp.systolic >= 130 || bp.diastolic >= 85) scores.hypertension = 0.6;
      else scores.hypertension = 0.1;
    }

    // Growth Restriction Risk
    if (latestVisit.FUNDAL_HEIGHT && latestVisit.GESTATIONAL_AGE_WEEKS) {
      const diff = Math.abs(latestVisit.FUNDAL_HEIGHT - latestVisit.GESTATIONAL_AGE_WEEKS);
      if (diff > 4) scores.growthRestriction = 0.7;
      else if (diff > 2) scores.growthRestriction = 0.3;
      else scores.growthRestriction = 0.1;
    }

    // Preterm Risk
    const currentGA = latestVisit.GESTATIONAL_AGE_WEEKS;
    if (currentGA < 37 && this.hasPretermHistory()) scores.pretermRisk = 0.6;
    else if (currentGA < 32) scores.pretermRisk = 0.3;
    else scores.pretermRisk = 0.1;

    // Maternal Age Risk
    const age = this.patient.AGE || 25;
    if (age < 18 || age > 35) scores.maternalAgeRisk = 0.4;
    else scores.maternalAgeRisk = 0.1;

    // BMI Risk
    const bmi = this.patient.BMI_VALUE;
    if (bmi) {
      if (bmi < 18.5 || bmi > 30) scores.bmiRisk = 0.5;
      else if (bmi > 25) scores.bmiRisk = 0.3;
      else scores.bmiRisk = 0.1;
    }

    return scores;
  }

  calculateDeliveryTypeProbabilities(riskScores) {
    const totalRisk = Object.values(riskScores).reduce((a, b) => a + b, 0) / Object.keys(riskScores).length;
    
    let Matured = Math.max(0.4, 0.80 - (totalRisk * 0.3));
    let premature = Math.min(0.4, 0.15 + (totalRisk * 0.2));
    let mortalityRisk = Math.min(0.2, 0.05 + (totalRisk * 0.1));

    const sum = Matured + premature + mortalityRisk;
    Matured /= sum;
    premature /= sum;
    mortalityRisk /= sum;

    return {
      Matured: this.roundProbability(Matured),
      Premature: this.roundProbability(premature),
      MortalityRisk: this.roundProbability(mortalityRisk)
    };
  }

  calculateDeliveryModeProbabilities(riskScores) {
    const cSectionRisk = Math.min(0.7, 
      riskScores.hypertension * 0.4 + 
      riskScores.growthRestriction * 0.3 +
      riskScores.bmiRisk * 0.2 +
      ((this.patient.PARITY === 0 || this.patient.PARITY === '0') ? 0.1 : 0)
    );

    return {
      Normal: this.roundProbability(1 - cSectionRisk),
      CSection: this.roundProbability(cSectionRisk)
    };
  }

  // 📈 Generate realistic weekly progression until 40 weeks
// 📈 Generate realistic weekly progression including current week up to 40 weeks
generateProgression(currentGA, weeksToProjectInput) {
  const latest = this.validatedVisits.at(-1);
  const bp = this.parseBloodPressure(latest.BLOOD_PRESSURE);

  // Always project up to week 40, starting from current week
  const weeksToProject = Math.max(0, 40 - currentGA + 1); // +1 to include current week
  
  const base = {
    weight: latest.MATERNAL_WEIGHT || 60,
    fundal: latest.FUNDAL_HEIGHT || currentGA,
    hb: latest.HEMOGLOBIN_LEVEL || 11.5,
    fhr: latest.FETAL_HEART_RATE || 145,
  };






  const weightTrend = this.calculateTrend("MATERNAL_WEIGHT");
  const hbTrend = this.calculateTrend("HEMOGLOBIN_LEVEL");

  const progression = {
    weight: [],
    fundal: [],
    hb: [],
    systolic: [],
    diastolic: [],
    fetal_hr: [],
  };
  progression.weight.push({
    week: currentGA,
    value: base.weight,
    isActual: true
  });
  
  progression.fundal.push({
    week: currentGA,
    value: base.fundal,
    isActual: true
  });
  
  progression.hb.push({
    week: currentGA,
    value: base.hb,
    isActual: true
  });
  progression.systolic.push({
    week: currentGA,
    value: base.systolic,
    isActual: true
  });
  
  progression.diastolic.push({
    week: currentGA,
    value: base.diastolic,
    isActual: true
  });
  
  progression.fetal_hr.push({
    week: currentGA,
    value: base.fhr,
    isActual: true
  });


  // Start from current week (week 12) and go up to week 40
  for (let i = 0; i < weeksToProject; i++) {
    const week = currentGA + i;

    // For week 0 (current week), use actual data
    if (i === 0) {
      progression.weight.push({
        week,
        value: base.weight,
      });
      progression.fundal.push({
        week,
        value: base.fundal,
      });
      progression.hb.push({
        week,
        value: base.hb,
      });
      
      const currentBP = this.parseBloodPressure(latest.BLOOD_PRESSURE);
      progression.systolic.push({
        week,
        value: currentBP.systolic,
      });
      progression.diastolic.push({
        week,
        value: currentBP.diastolic,
      });
      
      progression.fetal_hr.push({
        week,
        value: base.fhr,
      });
      continue;
    }

    const weightGain = this.calculateWeightGain(week, base.weight, weightTrend);
    progression.weight.push({
      week,
      value: this.roundValue(weightGain, 1),
    });

    // Fundal Height (closely follows gestational age ±1 cm)
    progression.fundal.push({
      week,
      value: this.roundValue(week + (Math.random() * 2 - 1), 1),
    });

    // Hemoglobin (slightly decreases, then stabilizes)
    const hbDecline = this.calculateHbDecline(week, base.hb, hbTrend);
    progression.hb.push({
      week,
      value: this.roundValue(hbDecline, 1),
    });

    // Blood Pressure (minor increase, stable trend)
    progression.systolic.push({
      week,
      value: Math.round(bp.systolic + i * 0.25 + (Math.random() * 2 - 1)),
    });

    progression.diastolic.push({
      week,
      value: Math.round(bp.diastolic + i * 0.15 + (Math.random() * 2 - 1)),
    });

    // Fetal Heart Rate (stable 120–160 bpm range with mild variability)
    let fhrValue = base.fhr + Math.sin(i / 3) * 2 + (Math.random() * 3 - 1.5);
    fhrValue = Math.min(160, Math.max(120, fhrValue)); // clamp to safe range

    progression.fetal_hr.push({
      week,
      value: Math.round(fhrValue),
    });
  }

  return progression;
}

  calculateWeightGain(week, baseWeight, trend) {
    const baseGain = 0.3;
    const patientSpecificGain = baseGain + (trend * 0.1);
    const weeksFromStart = week - this.validatedVisits[0].GESTATIONAL_AGE_WEEKS;
    return baseWeight + (weeksFromStart * patientSpecificGain);
  }

  calculateHbDecline(week, baseHb, trend) {
    const baseDecline = 0.05;
    const patientSpecificDecline = baseDecline + (trend * 0.02);
    const weeksFromStart = week - this.validatedVisits[0].GESTATIONAL_AGE_WEEKS;
    return Math.max(9.5, baseHb - (weeksFromStart * patientSpecificDecline));
  }

  calculateTrend(field) {
    if (this.validatedVisits.length < 2) return 0;
    
    const sortedVisits = [...this.validatedVisits].sort((a, b) => a.GESTATIONAL_AGE_WEEKS - b.GESTATIONAL_AGE_WEEKS);
    const first = sortedVisits[0][field];
    const last = sortedVisits[sortedVisits.length - 1][field];
    
    if (!first || !last) return 0;
    
    const weekDiff = sortedVisits[sortedVisits.length - 1].GESTATIONAL_AGE_WEEKS - sortedVisits[0].GESTATIONAL_AGE_WEEKS;
    return weekDiff > 0 ? (last - first) / weekDiff : 0;
  }

  parseBloodPressure(bpString) {
    if (!bpString) return { systolic: 115, diastolic: 70 };
    try {
      const parts = bpString.split('/').map(Number);
      return {
        systolic: parts[0] || 115,
        diastolic: parts[1] || 70
      };
    } catch (error) {
      return { systolic: 115, diastolic: 70 };
    }
  }

  hasPretermHistory() {
    return (this.patient.PARITY > 0 || this.patient.PARITY === '1') && 
           this.patient.MEDICAL_HISTORY?.toLowerCase().includes('preterm');
  }

  generateSummary(riskScores, deliveryType, deliveryMode) {
    const primaryRisk = Object.entries(riskScores).reduce((a, b) => a[1] > b[1] ? a : b)[0];
    const riskLevel = riskScores[primaryRisk] > 0.7 ? 'high' : riskScores[primaryRisk] > 0.4 ? 'moderate' : 'low';

    const MATUREDPercent = Math.round(deliveryType.Matured * 100);
    const prematurePercent = Math.round(deliveryType.Premature * 100);s
    
    const summaries = {
      low: `Patient shows stable progression with ${MATUREDPercent}% likelihood of MATURED normal delivery. Continue routine antenatal monitoring.`,
      moderate: `Moderate ${this.formatRiskName(primaryRisk)} risk noted. ${MATUREDPercent}% chance of MATURED delivery with increased monitoring recommended.`,
      high: `Elevated ${this.formatRiskName(primaryRisk)} risk requires close monitoring. ${prematurePercent}% premature delivery risk. Consider specialist consultation.`
    };

    return summaries[riskLevel] || summaries.low;
  }

  formatRiskName(riskKey) {
    const names = {
      anemia: 'anemia',
      hypertension: 'hypertension', 
      growthRestriction: 'fetal growth restriction',
      pretermRisk: 'preterm delivery',
      maternalAgeRisk: 'maternal age',
      bmiRisk: 'BMI-related'
    };
    return names[riskKey] || riskKey;
  }

  roundProbability(value) {
    return Math.round(value * 100) / 100;
  }

  roundValue(value, decimals = 2) {
    return Number(value.toFixed(decimals));
  }

  getFallbackPrediction() {
    return {
      deliveryType: { "Matured": 0.80, "Premature": 0.15, "MortalityRisk": 0.05 },
      deliveryMode: { "Normal": 0.70, "CSection": 0.30 },
      progression: { 
        weight: [], 
        fundal: [], 
        hb: [], 
        systolic: [], 
        diastolic: [], 
        fetal_hr: [] 
      },
      summary: "Using standard pregnancy progression model - insufficient patient data for personalized prediction.",
      isFallback: true,
      metadata: {
        source: "fallback-model",
        generatedAt: new Date().toISOString()
      }
    };
  }
}

export default PredictionEngine;