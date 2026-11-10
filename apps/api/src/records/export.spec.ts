import ExcelJS from 'exceljs';
import { safeCell, Sheet, toPdf, toXlsx } from './export';

const sheet: Sheet = {
  name: 'Visits',
  columns: [{ header: 'Reference', key: 'ref' }, { header: 'Visitor', key: 'name' }, { header: 'Minutes', key: 'mins', pdf: false }],
  rows: [{ ref: 'V-1', name: '=HYPERLINK("http://evil","x")', mins: 5 }, { ref: 'V-2', name: 'Nimal', mins: 12 }],
};

describe('safeCell (formula injection)', () => {
  it.each(['=1+1', '+SUM(A1)', '-2', '@cmd', '\tTAB', '\rCR'])('neutralises %j', (v) => {
    expect(safeCell(v).toString().startsWith("'")).toBe(true);
  });
  it('leaves normal values alone and strips XML-illegal control characters', () => {
    expect(safeCell('Nimal Perera')).toBe('Nimal Perera');
    expect(safeCell(42)).toBe(42);
    expect(safeCell(null)).toBe('');
    expect(safeCell('a\u0001b')).toBe('ab');
  });
});

describe('exports', () => {
  it('writes an xlsx whose hostile text is stored as a string, not a formula', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await toXlsx([sheet])) as any);
    const cell = wb.getWorksheet('Visits')!.getRow(2).getCell(2);
    expect(typeof cell.value).toBe('string');
    expect(String(cell.value).startsWith("'=")).toBe(true);
    expect(wb.getWorksheet('Visits')!.getRow(1).getCell(1).value).toBe('Reference');
  });
  it('writes a PDF', async () => {
    const buf = await toPdf('Visitor records', 'test', [sheet]);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(500);
  });
  it('paginates a long table without throwing', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ ref: `V-${i}`, name: `Visitor ${i}`, mins: i }));
    await expect(toPdf('Long', 'x', [{ ...sheet, rows }])).resolves.toBeInstanceOf(Buffer);
  });
});
