const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, VerticalAlign, PageBreak,
} = require('docx');
const fs = require('fs');

const border = { style: BorderStyle.SINGLE, size: 1, color: "999999" };
const borders = { top: border, bottom: border, left: border, right: border };

const page1Data = [
  ["Моздок / мобильный", "201/226"],
  ["Киря", "212"],
  ["Ока", "210"],
  ["Костер / мобильный", "204/217"],
  ["Каспий", "223"],
  ["Гранит", "221"],
  ["Нева", "2024"],
  ["Гроза", "211"],
  ["Аха", "214"],
  ["Тигр", "229"],
  ["Бик", "238"],
  ["Эталон", "203"],
  ["Зема", "206"],
  ["Жетон", "215"],
  ["Провод / мобильный", "227"],
  ["Крюк", "217"],
  ["Гоголь", "239"],
  ["Акцент", "219"],
  ["Беркут", "216"],
  ["Болото", "228"],
  ["Бритва", "202"],
  ["Бритва танк", "225"],
  ["Дербент", "213"],
  ["Мамура", "230"],
  ["Иса", "220"],
  ["Север", "222"],
  ["Старый", "208"],
  ["Хан", "205"],
  ["Ястреб", "210"],
  ["Беркут беспроводной", "231"],
  ["Бугор", "209"],
  ["Коба", "232"],
  ["Скай", "333"],
  ["Умань", "322"],
  ["Малёк", "236"],
  ["БПЛА Ямное", "235"],
  ["Пётр", "237"],
  ["Закат", "234"],
  ["Кузя", "242"],
  ["Гоголь", "239"],
  ["Тагил", "243"],
  ["Дежурный по батальону ПДБ", "202"],
];

const page2Data = [
  ["Седой", "233"],
  ["Кузя", "242"],
  ["Боца", "245"],
  ["Гоголь", "239"],
  ["Спартанец", "250"],
];

function makeRow(name, number) {
  return new TableRow({
    children: [
      new TableCell({
        borders,
        width: { size: 5500, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        verticalAlign: VerticalAlign.CENTER,
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: name, font: "Arial", size: 22 })]
        })]
      }),
      new TableCell({
        borders,
        width: { size: 2860, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        verticalAlign: VerticalAlign.CENTER,
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: number, font: "Arial", size: 22 })]
        })]
      }),
    ]
  });
}

function makeTable(data) {
  return new Table({
    width: { size: 8360, type: WidthType.DXA },
    columnWidths: [5500, 2860],
    rows: data.map(([name, num]) => makeRow(name, num)),
  });
}

const doc = new Document({
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
      }
    },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: "Список ip номеров", bold: true, font: "Arial", size: 26 })]
      }),
      makeTable(page1Data),
      new Paragraph({ children: [new PageBreak()] }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
        children: [new TextRun({ text: "2", bold: true, font: "Arial", size: 26 })]
      }),
      makeTable(page2Data),
    ]
  }]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("D:\sites\VPS_downloader\список_ip_номеров.docx", buffer);
  console.log("Done");
});
