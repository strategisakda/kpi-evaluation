// Claude AI — ผู้ช่วยตรวจหลักฐานเบื้องต้น (advisory เท่านั้น ไม่ตัดสินคะแนน)
// พอร์ต prompt มาจาก Code.gs ต้นฉบับ (analyzeEvidenceWithAI, generateProvinceKpiNarrative) แบบคำต่อคำ
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

function requireApiKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const e = new Error('ยังไม่ได้ตั้งค่า Anthropic API Key (ตัวแปรแวดล้อม ANTHROPIC_API_KEY)');
    e.statusCode = 400;
    throw e;
  }
  return key;
}

async function callClaude(apiKey, requestBody) {
  const httpResponse = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await httpResponse.text();
  if (httpResponse.status !== 200) {
    throw new Error(`เรียก AI ไม่สำเร็จ (HTTP ${httpResponse.status}): ${responseText.substring(0, 300)}`);
  }
  const parsed = JSON.parse(responseText);
  if (parsed.stop_reason === 'max_tokens') {
    throw new Error('คำตอบของ AI ยาวเกินกำหนดและถูกตัดกลางคัน กรุณาลองใหม่อีกครั้ง');
  }
  const textBlock = (parsed.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('AI ไม่ได้ตอบกลับข้อความที่อ่านได้ (อาจถูกปฏิเสธด้วยเหตุผลด้านความปลอดภัย)');
  try {
    return JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error('AI ตอบกลับมาไม่ครบสมบูรณ์ กรุณาลองใหม่อีกครั้ง');
  }
}

// อ่านไฟล์หลักฐาน 1 ไฟล์ (PDF/รูปภาพ) แล้วให้ข้อมูลประกอบการพิจารณา 4 อย่าง — ไม่มีทางเขียนคะแนนได้
async function analyzeEvidenceWithAI(supabase, bucket, { district, kpiName, kpiNote, kpiLevels, evidenceFilePath, evidenceMimeType }) {
  const apiKey = requireApiKey();

  const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(evidenceFilePath);
  if (dlErr) throw new Error('ดาวน์โหลดไฟล์หลักฐานไม่สำเร็จ: ' + dlErr.message);
  const buffer = Buffer.from(await blob.arrayBuffer());
  const base64 = buffer.toString('base64');

  let fileBlock;
  if (evidenceMimeType === 'application/pdf') {
    fileBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  } else if ((evidenceMimeType || '').indexOf('image/') === 0) {
    fileBlock = { type: 'image', source: { type: 'base64', media_type: evidenceMimeType, data: base64 } };
  } else {
    const e = new Error(`AI รองรับเฉพาะไฟล์ PDF หรือรูปภาพเท่านั้น (ไฟล์นี้เป็นชนิด ${evidenceMimeType})`);
    e.statusCode = 400;
    throw e;
  }

  const promptText =
    'อำเภอที่ส่งหลักฐานนี้: ' + district + '\n' +
    'ตัวชี้วัด: ' + kpiName + '\n' +
    'รายละเอียด/เกณฑ์ที่กำหนดไว้: ' + (kpiNote || '-') + '\n' +
    'เกณฑ์ระดับคะแนน 1-5: ' + kpiLevels.join(' | ') + '\n\n' +
    'อ่านไฟล์หลักฐานที่แนบมา แล้วตรวจสอบว่าเนื้อหาในไฟล์ "สอดคล้อง" กับตัวชี้วัดและเกณฑ์ที่กำหนดไว้ข้างต้นหรือไม่ ' +
    'ห้ามตัดสินว่าสอดคล้องเพียงเพราะมีคำหรือหัวข้อคล้ายกัน (เช่น มีคำว่า "แผนพัฒนา" เหมือนกัน) ต้องอ่านเนื้อหาจริงในเอกสารเพื่อยืนยันก่อนเสมอ\n' +
    'ข้อสำคัญข้อที่ 1 (ระดับ/ขอบเขตของเอกสาร): ตรวจสอบว่า "ระดับ" ของเอกสารตรงกับที่ตัวชี้วัดต้องการหรือไม่ เช่น หากตัวชี้วัดต้องการแผน/ข้อมูล "รายบุคคล" (ของเจ้าหน้าที่แต่ละคน) ' +
    'แต่เอกสารที่แนบมาเป็นแผนระดับชุมชน/พื้นที่/ตำบล/อำเภอ (ภาพรวมของพื้นที่ทั้งหมด ไม่เจาะจงเจ้าหน้าที่คนใดคนหนึ่งเลย) ถือว่าคนละระดับ ให้ตอบ "ไม่สอดคล้อง" ทันที ' +
    'ข้อยกเว้น: เอกสารบันทึกข้อความ/รายงานสรุปที่จัดทำในนามหน่วยงาน แต่มีการระบุชื่อเจ้าหน้าที่รายบุคคล หรือรหัสแผนรายบุคคล (Plan ID) ที่เจาะจงเป็นรายคนชัดเจน ให้ถือเป็นหลักฐานระดับรายบุคคลได้ ไม่ใช่ภาพรวมที่ต้องปฏิเสธ\n' +
    'ข้อสำคัญข้อที่ 2 (อำเภอที่ถูกต้อง): ต้องตรวจสอบด้วยว่าเอกสารหลัก (บันทึกข้อความ/รายงาน/แผนที่หน่วยงานเป็นผู้จัดทำเอง) เป็นของอำเภอ "' + district + '" จริงหรือไม่ (ดูจากชื่ออำเภอ/ตำบล/ชื่อเจ้าหน้าที่ผู้จัดทำที่ปรากฏในเอกสารหลัก) ' +
    'หากเนื้อหาตรงประเด็นตัวชี้วัดแต่เอกสารหลักเป็นของอำเภออื่น ให้ถือว่า "ไม่สอดคล้อง" ทันที และระบุชื่ออำเภอที่ปรากฏในเอกสารไว้ในจุดสังเกตด้วย ' +
    'ข้อยกเว้นสำคัญ: ใบรับรอง/ประกาศนียบัตรจากการอบรมภายนอก (เช่น Microsoft, สถาบันอบรมต่างๆ, มหาวิทยาลัย) จะมีชื่อหน่วยงานผู้จัดอบรม/ผู้ออกใบรับรองแสดงอยู่เสมอ ซึ่งเป็นเรื่องปกติของหลักฐานประกอบ ' +
    'ห้ามใช้ชื่อหน่วยงานภายนอกบนใบรับรองเหล่านี้เป็นเหตุผลตัดสินว่าผิดอำเภอเด็ดขาด ให้ดูจากเอกสารหลักของหน่วยงานเองเท่านั้นว่าเป็นของอำเภอที่ถูกต้องหรือไม่\n' +
    'โดยไม่ต้องตัดสินว่าควรได้กี่คะแนน (การตัดสินคะแนนเป็นหน้าที่ของนักวิชาการผู้ตรวจเท่านั้น) ให้ตอบ 4 เรื่อง:\n' +
    '1) เนื้อหาในไฟล์นี้สอดคล้องกับตัวชี้วัดและเกณฑ์ที่กำหนดไว้หรือไม่ ทั้งในแง่ระดับ/ขอบเขตของเอกสาร (รายบุคคล vs ชุมชน/พื้นที่) และเป็นเอกสารของอำเภอ "' + district + '" จริงหรือไม่\n' +
    '2) สรุปเนื้อหาในไฟล์แบบสั้น กระชับ อ่านง่าย (ภาษาไทย)\n' +
    '3) จุดที่ไม่สอดคล้อง หรือจุดสังเกตที่ควรให้นักวิชาการตรวจสอบเพิ่มเติม (ถ้าเอกสารผิดระดับหรือเป็นของอำเภออื่น ให้ระบุรายละเอียดที่ถูกต้องตรงนี้ ถ้าไม่มีจุดสังเกตให้ตอบเป็น list ว่าง)\n' +
    '4) ข้อเสนอแนะสั้นๆ ที่เป็นรูปธรรมว่าอำเภอควรพัฒนา/ปรับปรุงเรื่องใดเพิ่มเติม เพื่อให้หลักฐานสอดคล้องกับเกณฑ์ระดับคะแนนที่สูงขึ้นในรอบถัดไป ' +
    '(ชี้เป้าเป็นข้อๆ เจาะจงว่าอำเภอควรทำอะไรเพิ่ม ไม่ใช่แค่บอกว่าขาดอะไร ถ้าหลักฐานสอดคล้องและครบถ้วนดีอยู่แล้วให้ตอบเป็น list ว่าง)';

  const result = await callClaude(apiKey, {
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: promptText }] }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            consistency: { type: 'string', enum: ['สอดคล้อง', 'ไม่แน่ใจ', 'ไม่สอดคล้อง'] },
            summary: { type: 'string' },
            observations: { type: 'array', items: { type: 'string' } },
            recommendations: { type: 'array', items: { type: 'string' } },
          },
          required: ['consistency', 'summary', 'observations', 'recommendations'],
          additionalProperties: false,
        },
      },
    },
  });

  return {
    consistency: result.consistency,
    summary: result.summary,
    observations: result.observations || [],
    recommendations: result.recommendations || [],
  };
}

// สรุปภาพรวมทั้งจังหวัดจากคะแนนเฉลี่ยที่มีอยู่แล้ว (ไม่ตัดสินคะแนนใหม่)
async function generateProvinceNarrative(provinceSummaryRows) {
  const apiKey = requireApiKey();
  const scored = provinceSummaryRows.filter((r) => r.reviewedCount > 0);
  if (!scored.length) {
    const e = new Error('ยังไม่มีตัวชี้วัดใดถูกให้คะแนนในรอบนี้ กรุณาให้นักวิชาการตรวจให้คะแนนก่อน');
    e.statusCode = 400;
    throw e;
  }

  const dataText = scored
    .map((r) => {
      const weak = r.weakDistricts.length ? ' — อำเภอคะแนนต่ำ (≤3): ' + r.weakDistricts.join(', ') : '';
      return `- ${r.kpiName} (น้ำหนัก ${r.weight}%): คะแนนเฉลี่ย ${r.avgScore}/5 จาก ${r.reviewedCount}/${r.totalCount} อำเภอที่ตรวจแล้ว${weak}`;
    })
    .join('\n');

  const promptText =
    'ข้อมูลคะแนนเฉลี่ยรายตัวชี้วัดของทั้งจังหวัด ในรอบการประเมินปัจจุบัน (คะแนนนี้นักวิชาการให้ไว้แล้ว ไม่ต้องตัดสินใหม่):\n' + dataText + '\n\n' +
    'จากข้อมูลนี้ ช่วยสรุปภาพรวมทั้งจังหวัดให้ผู้บริหารอ่านสั้นๆ กระชับ เป็นภาษาไทย ให้ตอบ 3 เรื่อง:\n' +
    '1) จุดแข็งของจังหวัด — ตัวชี้วัดที่คะแนนเฉลี่ยสูงหรือทำได้ดีโดยรวม\n' +
    '2) จุดอ่อนของจังหวัด — ตัวชี้วัดที่คะแนนเฉลี่ยต่ำ หรือมีหลายอำเภอคะแนนต่ำ\n' +
    '3) ตัวชี้วัดที่ควรโฟกัสเป็นพิเศษในการพัฒนาต่อไป พร้อมเหตุผลสั้นๆ ว่าทำไมถึงควรโฟกัสตัวนี้ก่อน';

  const result = await callClaude(apiKey, {
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            strengths: { type: 'array', items: { type: 'string' } },
            weaknesses: { type: 'array', items: { type: 'string' } },
            focusAreas: { type: 'array', items: { type: 'string' } },
          },
          required: ['strengths', 'weaknesses', 'focusAreas'],
          additionalProperties: false,
        },
      },
    },
  });

  return {
    strengths: result.strengths || [],
    weaknesses: result.weaknesses || [],
    focusAreas: result.focusAreas || [],
  };
}

module.exports = { analyzeEvidenceWithAI, generateProvinceNarrative };
