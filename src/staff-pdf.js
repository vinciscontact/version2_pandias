// Hotel Pandia's: branded PDF reports for the staff app.
// Loaded only when someone taps "Download PDF" (a separate file), so the app itself stays small and fast.
//
// makePdf({ title, place, by, file, sections })
//   sections: { kpis: [[label, value], …] }
//             { heading, head: [...], body: [[...], …], align?: { colIndex: "right" } }
//             { text }
// The built-in PDF fonts cover English only: "₹" is written as "Rs", and letters they can't draw
// (Tamil, emoji) are left out rather than printed as garbage.
import { jsPDF } from "jspdf";
import { autoTable } from "jspdf-autotable";

const MAROON = [58, 10, 16];
const GOLD = [232, 176, 74];
const CREAM = [255, 247, 234];
const SOFT = [122, 90, 76];
const LINE = [234, 222, 206];

export function clean(v) {
  const t = String(v ?? "")
    .replace(/₹\s?/g, "Rs ")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[·•]/g, "-")
    .replace(/×/g, "x")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return t;
}

export function makePdf({ title, place, by, file, sections }) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 14;
  const stamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

  // letterhead
  doc.setFillColor(...MAROON);
  doc.rect(0, 0, W, 30, "F");
  doc.setFillColor(...GOLD);
  doc.rect(0, 30, W, 1.2, "F");
  doc.setTextColor(...CREAM);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(17);
  doc.text("HOTEL PANDIA'S", M, 13);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.text(clean(place || "Chennai"), M, 20);
  doc.setFontSize(9);
  doc.text(clean(`Downloaded ${stamp}${by ? ` by ${by}` : ""}`), W - M, 20, { align: "right" });
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text(clean(title), W - M, 13, { align: "right" });

  let y = 42;
  const room = (need) => {
    if (y + need > H - 18) {
      doc.addPage();
      y = 18;
    }
  };

  for (const s of sections) {
    if (s.kpis) {
      const n = s.kpis.length;
      const gap = 4;
      const w = (W - 2 * M - gap * (n - 1)) / n;
      room(24);
      s.kpis.forEach(([label, value], i) => {
        const x = M + i * (w + gap);
        doc.setFillColor(253, 248, 240);
        doc.setDrawColor(...LINE);
        doc.roundedRect(x, y, w, 20, 2.5, 2.5, "FD");
        doc.setTextColor(...SOFT);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.text(clean(label), x + 4, y + 7);
        doc.setTextColor(...MAROON);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(14);
        doc.text(clean(value), x + 4, y + 15.5, { maxWidth: w - 8 });
      });
      y += 28;
      continue;
    }
    if (s.text) {
      room(10);
      doc.setTextColor(...SOFT);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      const lines = doc.splitTextToSize(clean(s.text), W - 2 * M);
      doc.text(lines, M, y);
      y += lines.length * 4.6 + 4;
      continue;
    }
    // a table
    room(20);
    if (s.heading) {
      doc.setTextColor(...MAROON);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11.5);
      doc.text(clean(s.heading).toUpperCase(), M, y);
      y += 3;
    }
    const styles = {};
    for (const [i, a] of Object.entries(s.align || {})) styles[i] = { halign: a };
    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M, bottom: 18 },
      head: s.head ? [s.head.map(clean)] : undefined,
      body: s.body.length ? s.body.map((r) => r.map(clean)) : [[{ content: s.empty || "Nothing to show.", colSpan: (s.head || [0]).length, styles: { textColor: SOFT, fontStyle: "italic" } }]],
      theme: "plain",
      styles: { font: "helvetica", fontSize: 9, cellPadding: 2.4, textColor: [42, 18, 14], lineColor: LINE, lineWidth: { bottom: 0.2 } },
      headStyles: { fillColor: [244, 236, 224], textColor: SOFT, fontStyle: "bold", fontSize: 8, lineWidth: 0 },
      alternateRowStyles: { fillColor: [253, 250, 245] },
      columnStyles: styles,
      // money columns line up on the right in the header and totals too
      didParseCell: (d) => {
        const a = s.align?.[d.column.index];
        if (a) d.cell.styles.halign = a;
      },
      foot: s.foot ? [s.foot.map(clean)] : undefined,
      footStyles: { fontStyle: "bold", textColor: MAROON, fillColor: [248, 227, 180] },
    });
    y = doc.lastAutoTable.finalY + 10;
  }

  // footer on every page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE);
    doc.line(M, H - 12, W - M, H - 12);
    doc.setTextColor(...SOFT);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text("Hotel Pandia's - for restaurant use only. Contains guests' names and numbers: keep it private.", M, H - 7);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 7, { align: "right" });
  }
  doc.save(file);
}
