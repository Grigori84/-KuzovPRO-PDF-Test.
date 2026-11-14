// node --test test/mobile-reflow.test.mjs
// Fictional PDF.js text layout matching the Android PrecisionPdf v3 geometry.
import test from "node:test";
import assert from "node:assert/strict";
import {parseEstimatePages,toLines} from "../mobile-reflow.mjs";

const piece=(t,x,y,font="normal")=>({t,x,y,font});
const line=(y,...items)=>({y,items,text:items.map(x=>x.t).join(" ")});

function fixture(price=676) {
  return [
    {lines:[
      line(45,piece("ПРЕДВАРИТЕЛЬНАЯ СМЕТА · №18/4",32,45,"bold"),
        piece("13.11.2026",501,45,"bold")),
      line(222,piece("АВТОМОБИЛЬ",46,222,"bold")),
      line(247,piece("Renault",46,247,"bold")),
      line(275,piece("Клиент: Иван Тестовый",46,275)),
      line(293,piece("Телефон: +7 900 000-00-00",46,293)),
      line(369,piece("Работ: 4",46,369)),
      line(410,piece("Перечень работ",32,410,"bold")),
      line(443,piece("№",43,443),piece("НАИМЕНОВАНИЕ РАБОТЫ",69,443,"bold")),
      line(478,piece("01",41,478),piece("Капот — замена + окраска",69,478),piece("100 ₽",521,478)),
      line(514,piece("02",41,514),piece("Кузовные работы",69,514),piece("26 ₽",522,514)),
      line(550,piece("03",41,550),piece("Бампер передний — замена",69,550),piece("500 ₽",522,550)),
      line(586,piece("04",41,586),piece("Стойка — снятие + установка",69,586),piece("50 ₽",522,586)),
      line(650,piece("Итого с материалами",48,650,"bold"),piece(price+" ₽",523,650,"bold"))
    ]},
    {lines:[
      line(47,piece("ЭКСПЕРТ",32,47,"bold"),piece("Смета №18/4",500,47)),
      line(104,piece("Важные условия ремонта",32,104,"bold"),piece("Перед согласованием",510,104)),
      line(137,piece("Скрытые повреждения",52,137,"bold")),
      line(169,piece("При разборке могут обнаружиться скрытые повреждения.",52,169)),
      line(187,piece("Все дополнительные работы согласовываются с клиентом.",52,187)),
      line(225,piece("Отключение аккумулятора",52,225,"bold")),
      line(257,piece("Для безопасности может потребоваться отключение АКБ.",52,257)),
      line(295,piece("Последствия отключения АКБ",52,295,"bold")),
      line(327,piece("После подключения могут сброситься настройки и часы.",52,327)),
      line(345,piece("Дополнительная диагностика согласовывается с клиентом.",52,345))
    ]}
  ];
}

test("reflows full estimate: car, four jobs, exact total, three conditions",()=>{
  const result=parseEstimatePages(fixture());
  assert.equal(result?.number,"18/4");
  assert.equal(result?.car,"Renault");
  assert.equal(result?.works.length,4);
  assert.equal(result?.works[3].label,"Стойка — снятие + установка");
  assert.equal(result?.total,676);
  assert.equal(result?.clauses.length,3);
  assert.match(result.clauses[0].body,/дополнительные работы/);
  assert.match(result.clauses[2].body,/согласовывается с клиентом/);
});

test("new plain title also parses, without preliminary label",()=>{
  const pages=fixture();
  pages[0].lines[0].items[0].t="СМЕТА №18/4";
  pages[0].lines[0].text=pages[0].lines[0].items.map(x=>x.t).join(" ");
  assert.equal(parseEstimatePages(pages)?.number,"18/4");
});

test("does not silently show inconsistent or incomplete estimates",()=>{
  assert.equal(parseEstimatePages(fixture(677)),null);
  const bad=fixture();bad[0].lines.splice(9,1);
  assert.equal(parseEstimatePages(bad),null);
  const empty=fixture();empty[1].lines.splice(3);
  assert.equal(parseEstimatePages(empty),null);
  assert.equal(parseEstimatePages([{lines:[]}]),null);
});

test("a long first legal clause alone must never appear as full conditions",()=>{
  const pages=fixture();
  pages[1].lines=pages[1].lines.filter(line=>line.y<225);
  assert.equal(parseEstimatePages(pages),null);
});

test("two clauses or a substituted heading trigger the original PDF fallback",()=>{
  const two=fixture();
  two[1].lines=two[1].lines.filter(line=>line.y<295);
  assert.equal(parseEstimatePages(two),null);
  const renamed=fixture();
  const title=renamed[1].lines.find(line=>line.y===225);
  title.items[0].t="Иные условия";
  title.text=title.items.map(i=>i.t).join(" ");
  assert.equal(parseEstimatePages(renamed),null);
});

test("custom legal terms use PDF until a completeness-proof protocol exists",()=>{
  const custom=fixture();
  const extra=custom[1].lines.find(line=>line.y===295);
  extra.items[0].t="Особые условия";
  extra.text=extra.items.map(i=>i.t).join(" ");
  assert.equal(parseEstimatePages(custom),null);
});

test("groups extracted text by baseline and x position",()=>{
  const raw={items:[
    {str:"Ремонт",transform:[1,0,0,1,69,365],width:40},
    {str:"100 ₽",transform:[1,0,0,1,500,365],width:28},
    {str:"01",transform:[1,0,0,1,41,365],width:9}
  ]};
  const lines=toLines(raw,842);
  assert.equal(lines.length,1);
  assert.equal(lines[0].y,477);
  assert.equal(lines[0].text,"01 Ремонт 100 ₽");
});
