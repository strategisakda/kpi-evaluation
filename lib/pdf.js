// รายงานสรุปคะแนนทั้ง 11 อำเภอ (PDF) — พอร์ตจาก Code.gs (DocumentApp) มาเป็น pdfkit
// ฟอนต์ Sarabun ฝังไว้ใน assets/fonts เพื่อรองรับภาษาไทย (pdfkit เดิมไม่มีฟอนต์ไทย)
const PDFDocument = require('pdfkit');
const path = require('path');

const FONT_REGULAR = path.join(__dirname, '..', 'assets', 'fonts', 'Sarabun-Regular.ttf');
const FONT_BOLD = path.join(__dirname, '..', 'assets', 'fonts', 'Sarabun-Bold.ttf');
const CHUNK_SIZE = 4;

function formatDateThai(date) {
  return date.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + date.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
}

function generateProvinceReportPdf(districts, kpiMaster, allRows) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('th', FONT_REGULAR);
    doc.registerFont('th-bold', FONT_BOLD);

    const teamKpis = kpiMaster.filter((k) => k.category === 'TEAM');
    const indivKpis = kpiMaster.filter((k) => k.category !== 'TEAM');
    const shortLabel = (kpi) => {
      const idx = kpi.category === 'TEAM' ? teamKpis.indexOf(kpi) : indivKpis.indexOf(kpi);
      return (kpi.category === 'TEAM' ? 'ทีม ' : 'บุคคล ') + (idx + 1);
    };

    function scoreOf(district, kpiId) {
      const r = allRows.find((x) => x.district === district && x.kpi_id === kpiId);
      const score = r ? Number(r.score) : NaN;
      return score >= 1 && score <= 5 ? score : null;
    }

    const districtChunks = [];
    for (let i = 0; i < districts.length; i += CHUNK_SIZE) districtChunks.push(districts.slice(i, i + CHUNK_SIZE));

    districtChunks.forEach((chunk, chunkIdx) => {
      if (chunkIdx > 0) doc.addPage({ size: 'A4', layout: 'landscape', margin: 28 });

      doc.font('th-bold').fontSize(13).text(
        'แบบสรุปคะแนนประเมินหลักฐานเชิงประจักษ์ตัวชี้วัดและค่าเป้าหมายการประเมินผลการปฏิบัติราชการ',
        { align: 'center' }
      );
      doc.font('th').fontSize(9.5).text(
        'สำนักงานพัฒนาชุมชนจังหวัดพัทลุง — รอบการประเมินที่ 2/2569 (1 เม.ย. – 30 ก.ย. 2569)',
        { align: 'center' }
      );
      doc.text(`ข้อมูล ณ วันที่ ${formatDateThai(new Date())}  (หน้า ${chunkIdx + 1}/${districtChunks.length})`, { align: 'center' });
      doc.moveDown(0.6);

      const labelColW = 110;
      const usableW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const subColW = Math.max(38, Math.floor((usableW - labelColW) / (chunk.length * 3)));
      const startX = doc.page.margins.left;
      const rowH = 15;
      let y = doc.y;

      function drawRow(cells) {
        let x = startX;
        cells.forEach((cell) => {
          if (cell.bg) doc.rect(x, y, cell.width, rowH).fill(cell.bg);
          doc.fillColor('black').font(cell.bold ? 'th-bold' : 'th').fontSize(7.5)
            .text(cell.text, x + 2, y + 4, { width: cell.width - 4, align: cell.align || 'center', lineBreak: false });
          doc.rect(x, y, cell.width, rowH).stroke('#cccccc');
          x += cell.width;
        });
        y += rowH;
      }

      // แถวหัวตาราง 1: ชื่ออำเภอ (คร่อม 3 คอลัมน์ย่อย)
      var headerRow1 = [{ text: 'อำเภอ / ตัวชี้วัด', width: labelColW, bold: true, bg: '#cfe4da' }];
      chunk.forEach((d) => headerRow1.push({ text: d, width: subColW * 3, bold: true, bg: '#d6e4f0' }));
      drawRow(headerRow1);

      // แถวหัวตาราง 2: น้ำหนัก/คะแนน/ถ่วงน้ำหนัก
      var headerRow2 = [{ text: '', width: labelColW, bg: '#cfe4da' }];
      chunk.forEach(() => {
        headerRow2.push({ text: 'น้ำหนัก', width: subColW, bold: true, bg: '#d6e4f0' });
        headerRow2.push({ text: 'คะแนน', width: subColW, bold: true, bg: '#d6e4f0' });
        headerRow2.push({ text: 'ถ่วงน้ำหนัก', width: subColW, bold: true, bg: '#d6e4f0' });
      });
      drawRow(headerRow2);

      function kpiRow(kpi) {
        var cells = [{ text: shortLabel(kpi), width: labelColW }];
        chunk.forEach((district) => {
          const score = scoreOf(district, kpi.kpi_id);
          cells.push({ text: String(kpi.weight), width: subColW });
          cells.push({ text: score === null ? '-' : score.toFixed(2), width: subColW });
          cells.push({ text: score === null ? '-' : ((kpi.weight * score) / 100).toFixed(3), width: subColW });
        });
        drawRow(cells);
      }

      function sectionSubtotal(label, kpisInSection) {
        var cells = [{ text: label, width: labelColW, bold: true, bg: '#f5f0dc' }];
        var totals = [];
        chunk.forEach((district) => {
          var scores = [];
          var weighted = 0;
          kpisInSection.forEach((k) => {
            const score = scoreOf(district, k.kpi_id);
            if (score !== null) { scores.push(score); weighted += (k.weight * score) / 100; }
          });
          const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
          cells.push({ text: '100', width: subColW, bold: true, bg: '#f5f0dc' });
          cells.push({ text: avgScore.toFixed(2), width: subColW, bold: true, bg: '#f5f0dc' });
          cells.push({ text: weighted.toFixed(3), width: subColW, bold: true, bg: '#f5f0dc' });
          totals.push({ avgScore, weighted });
        });
        drawRow(cells);
        return totals;
      }

      teamKpis.forEach(kpiRow);
      const teamTotals = sectionSubtotal('รวมส่วนที่ 1 (รายทีม)', teamKpis);
      indivKpis.forEach(kpiRow);
      const indivTotals = sectionSubtotal('รวมส่วนที่ 2 (รายบุคคล)', indivKpis);

      var totalCells = [{ text: 'รวม (1 + 2)', width: labelColW, bold: true }];
      var finalCells = [{ text: 'คะแนนเฉลี่ยรวม (เต็ม 5.00)', width: labelColW, bold: true, bg: '#fbe6a8' }];
      chunk.forEach((d, i) => {
        const teamAvg = teamTotals[i].avgScore, teamW = teamTotals[i].weighted;
        const indivAvg = indivTotals[i].avgScore, indivW = indivTotals[i].weighted;
        totalCells.push({ text: '200', width: subColW, bold: true });
        totalCells.push({ text: (teamAvg + indivAvg).toFixed(2), width: subColW, bold: true });
        totalCells.push({ text: (teamW + indivW).toFixed(3), width: subColW, bold: true });
        finalCells.push({ text: '100', width: subColW, bold: true, bg: '#fbe6a8' });
        finalCells.push({ text: ((teamAvg + indivAvg) / 2).toFixed(2), width: subColW, bold: true, bg: '#fbe6a8' });
        finalCells.push({ text: ((teamW + indivW) / 2).toFixed(2), width: subColW, bold: true, bg: '#fbe6a8' });
      });
      drawRow(totalCells);
      drawRow(finalCells);
    });

    // หน้าคำอธิบายตัวชี้วัด
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 28 });
    doc.font('th-bold').fontSize(14).text('คำอธิบายตัวชี้วัด', { align: 'left' });
    doc.moveDown(0.5);
    var legendColW = [70, 400, 90, 90];
    var legendY = doc.y;
    var legendRowH = 18;
    function drawLegendRow(cells, bold, bg) {
      let x = doc.page.margins.left;
      cells.forEach((text, i) => {
        if (bg) { doc.rect(x, legendY, legendColW[i], legendRowH).fill(bg); }
        doc.fillColor('black').font(bold ? 'th-bold' : 'th').fontSize(8.5)
          .text(text, x + 3, legendY + 4, { width: legendColW[i] - 6, lineBreak: false });
        doc.rect(x, legendY, legendColW[i], legendRowH).stroke('#cccccc');
        x += legendColW[i];
      });
      legendY += legendRowH;
    }
    drawLegendRow(['รหัส', 'ชื่อตัวชี้วัด', 'ประเภท', 'น้ำหนัก'], true, '#e1f5ee');
    kpiMaster.forEach((k) => {
      drawLegendRow([shortLabel(k), k.kpi_name, k.category === 'TEAM' ? 'ทีม' : 'รายบุคคล', k.weight + '%'], false, null);
    });

    // บล็อกลงนาม
    doc.addPage({ size: 'A4', layout: 'landscape', margin: 28 });
    doc.font('th').fontSize(10);
    doc.moveDown(6);
    doc.text('ลงชื่อ .......................................................', { align: 'right' });
    doc.text('(นายประโมทย์  ดำจวนลม)', { align: 'right' });
    doc.text('พัฒนาการจังหวัดพัทลุง', { align: 'right' });
    doc.text('วันที่ ............ / ............ / ............', { align: 'right' });

    doc.end();
  });
}

module.exports = { generateProvinceReportPdf };
