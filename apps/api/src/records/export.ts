import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export type Cell = string | number | null | undefined;
export interface Column { header: string; key: string; width?: number; pdf?: boolean }
export interface Sheet { name: string; columns: Column[]; rows: Record<string, Cell>[] }

/**
 * Spreadsheet formula-injection guard (OWASP "CSV injection"): visitor-supplied text such as `=HYPERLINK(...)`
 * must never be interpreted as a formula by Excel / Sheets, so anything that could start one gets a leading quote.
 */
export function safeCell(v: Cell): string | number {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); // XML-illegal control chars
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export async function toXlsx(sheets: Sheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMS';
  wb.created = new Date();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    ws.columns = s.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18 }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of s.rows) ws.addRow(Object.fromEntries(s.columns.map((c) => [c.key, safeCell(r[c.key])])));
    if (s.columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Landscape A4 tables with a repeating header row. Deliberately plain: this is a report, not a layout engine. */
export function toPdf(title: string, subtitle: string, sheets: Sheet[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30, info: { Title: title, Creator: 'VMS' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const rowH = 16;

    doc.fontSize(16).font('Helvetica-Bold').text(title);
    doc.fontSize(9).font('Helvetica').fillColor('#555').text(subtitle).fillColor('#000').moveDown(0.5);

    for (const s of sheets) {
      const cols = s.columns.filter((c) => c.pdf !== false);
      if (!cols.length) continue;
      const totalW = cols.reduce((a, c) => a + (c.width ?? 18), 0);
      const widths = cols.map((c) => ((c.width ?? 18) / totalW) * usable);
      const drawRow = (vals: (string | number)[], bold: boolean) => {
        if (doc.y + rowH > bottom()) { doc.addPage(); drawHeader(); }
        const y = doc.y;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
        let x = left;
        vals.forEach((v, i) => {
          doc.text(String(v), x + 2, y + 3, { width: widths[i] - 4, height: rowH - 4, ellipsis: true, lineBreak: false });
          x += widths[i];
        });
        doc.moveTo(left, y + rowH).lineTo(left + usable, y + rowH).strokeColor('#ddd').lineWidth(0.5).stroke();
        doc.x = left; doc.y = y + rowH;
      };
      const drawHeader = () => drawRow(cols.map((c) => c.header), true);

      doc.font('Helvetica-Bold').fontSize(11).text(s.name).moveDown(0.3);
      drawHeader();
      for (const r of s.rows) drawRow(cols.map((c) => safeCell(r[c.key])), false);
      doc.moveDown(1);
    }
    doc.end();
  });
}
