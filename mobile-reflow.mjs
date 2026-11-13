/**
 * Mobile read view for existing, already-public immutable PDF estimates.
 *
 * All work is local to the visitor's browser: PDF.js reads the very same
 * PDF bytes as the print view, and no customer fields are sent to another
 * server, analytics service or third-party renderer.
 *
 * This is a strictly validated presentation adapter, NOT a second public
 * publication system. Unknown/historic PDF layouts remain in the original
 * PDF viewer. Never show a partial inferred estimate.
 */

const normalize = v => String(v || "").replace(/\s+/g, " ").trim();
const parsePrice = text => {
  const m = normalize(text).match(/(-?[\d\s\u00a0\u202f]+(?:[,.]\d{1,2})?)\s*₽/u);
  return m ? Number(m[1].replace(/[\s\u00a0\u202f]/g, "").replace(",", ".")) : null;
};
const rounded = (n, place = 2) => Math.round(n * 10**place) / 10**place;

/** PDF.js text transforms are in PDF coordinates (Y bottom-up). */
export function toLines(content, pageHeight) {
  const items = (content.items || []).filter(t => normalize(t.str)).map(t => ({
    t: normalize(t.str),
    x: Number(t.transform?.[4] || 0),
    y: Number(pageHeight - (t.transform?.[5] || 0)),
    font: t.fontName || "",
    width: Number(t.width || 0)
  }));
  items.sort((a, b) => a.y-b.y || a.x-b.x);
  const lines=[];
  for (const item of items) {
    const existing = lines.find(x => Math.abs(x.y-item.y) < 2.75);
    if (existing) existing.items.push(item);
    else lines.push({y:item.y,items:[item]});
  }
  for(const line of lines) {
    line.items.sort((a,b)=>a.x-b.x);
    line.text=normalize(line.items.map(t=>t.t).join(" "));
  }
  lines.sort((a,b)=>a.y-b.y);
  return lines;
}

const onPage = (page, cond) => (page?.lines || []).find(cond);
const pageItem = (page, cond) => (page?.lines || []).flatMap(x=>x.items).find(cond);
const moneyItems = group => group.items.filter(i=>i.x>=425 && /₽/u.test(i.t));
const rowNumber = group => group.items.find(i=>i.x<65 && /^\d{1,3}$/.test(i.t));

/**
 * Entire title, all numbered work lines, matching total and all conditions
 * are required. If a PDF cannot be understood unambiguously, return null
 * and show the *original* PDF without guessing customer information.
 */
export function parseEstimatePages(pages) {
  if(!Array.isArray(pages) || pages.length<1 || pages.length>40) return null;
  const first=pages[0],all=pages.flatMap((page,p)=>page.lines.map(l=>({...l,p})));
  const top=first.lines.find(l=>/СМЕТА\s*.*№\s*\d+\/\d+/i.test(l.text) && l.y<85);
  const number=top?.text.match(/№\s*(\d+\/\d+)/)?.[1];
  const date=pageItem(first,i=>/^\d{2}\.\d{2}\.\d{4}$/.test(i.t) && i.y<85)?.t;
  const carLabel=onPage(first,l=>l.items.some(i=>i.t==="АВТОМОБИЛЬ"));
  const client=pageItem(first,i=>/^Клиент:\s*.+/i.test(i.t));
  const phone=pageItem(first,i=>/^Телефон:\s*.+/i.test(i.t));
  const count=pageItem(first,i=>/^Работ:\s*\d+$/i.test(i.t));
  const tableTitle=all.find(l=>l.text.includes("Перечень работ"));
  const conditionsTitle=all.find(l=>l.text.includes("Важные условия ремонта"));
  const totalLine=all.find(l=>l.text.includes("Итого с материалами"));
  const totalItem=totalLine?.items.find(i=>/₽/u.test(i.t));
  if(!number||!date||!carLabel||!client||!count||!tableTitle||!conditionsTitle||!totalLine||!totalItem) return null;

  const clientName=normalize(client.t.replace(/^Клиент:\s*/i,""));
  const phoneValue=phone ? normalize(phone.t.replace(/^Телефон:\s*/i,"")) : "";
  const carItems=first.lines.filter(l=>l.y>carLabel.y+12 && l.y<client.y-7)
    .flatMap(l=>l.items.filter(i=>i.x>=43 && i.x<390 && !/Клиент:|Телефон:/.test(i.t)));
  const car=normalize(carItems.map(i=>i.t).join(" "));
  const workCount=Number(count.t.match(/\d+/)?.[0]||0);
  const total=parsePrice(totalItem.t);
  if(!car||!clientName||!Number.isFinite(total)||workCount<1||workCount>500)return null;

  // Build rows from actual native-PDF table coordinates and numbered positions.
  const jobs=[];
  let inTable=false;
  const flat=all.slice().sort((a,b)=>a.p-b.p||a.y-b.y);
  for(const line of flat) {
    if(line.text.includes("НАИМЕНОВАНИЕ РАБОТЫ")) {inTable=true;continue}
    if(line.text.includes("Итого с материалами")) {inTable=false;break}
    if(!inTable || line.y>795 || line.y<80)continue;
    const numberItem=rowNumber(line);
    if(numberItem) {
      const rowNo=Number(numberItem.t);
      if(rowNo!==jobs.length+1)return null;
      jobs.push({number:rowNo,label:"",price:null});
    }
    if(!jobs.length)continue;
    const current=jobs[jobs.length-1];
    const names=line.items.filter(i=>i.x>=68&&i.x<420&&i.y>80)
      .map(i=>i.t).filter(t=>!t.includes("НАИМЕНОВАНИЕ РАБОТЫ"));
    if(names.length)current.label=normalize(current.label+" "+names.join(" "));
    const priceText=line.items.filter(i=>i.x>=425).map(i=>i.t).join(" ");
    const price=parsePrice(priceText);
    if(price!==null)current.price=price;
  }
  if(jobs.length!==workCount||jobs.some(j=>!j.label||j.price===null||!Number.isFinite(j.price)))return null;
  const priceSum=rounded(jobs.reduce((sum,j)=>sum+j.price,0));
  if(rounded(total)!==priceSum)return null;

  // Legal terms: preserve every extracted line below the "conditions" heading.
  // The font used for a clause heading is the same bold face as the section
  // heading. On PDF generators which discard font metadata, use visual gaps.
  const titleFont=conditionsTitle.items.find(i=>i.t.includes("Важные условия ремонта"))?.font;
  const clauses=[];
  let reading=false,previous=null;
  for(const line of flat) {
    if(line.p===conditionsTitle.p && line.y===conditionsTitle.y){reading=true;continue}
    if(!reading || line.y>796)continue;
    const body=line.items.filter(i=>i.x>=49 && i.x<=565);
    if(!body.length)continue;
    const txt=normalize(body.map(i=>i.t).join(" "));
    if(!txt || txt==="Перед согласованием" || txt==="ЭКСПЕРТ" ||
      /^Смета №\d+\/\d+/.test(txt) ||
      txt.includes("Важные условия ремонта"))continue;
    // No page footer is included; footer baselines are at y=819.
    const isBold=!!titleFont && body.some(i=>i.font===titleFont);
    const gap=previous && previous.p===line.p ? line.y-previous.y : 40;
    const heading=(isBold && (gap>18 || !clauses.length)) ||
      ((!titleFont || !body.some(i=>i.font)) && gap>23);
    if(!clauses.length || (heading && clauses[clauses.length-1].body.length)) {
      clauses.push({title:txt,body:[]});
    } else if(heading && clauses[clauses.length-1].body.length===0) {
      clauses[clauses.length-1].title+=" "+txt;
    } else {
      clauses[clauses.length-1].body.push(txt);
    }
    previous={p:line.p,y:line.y};
  }
  if(clauses.length<1 || clauses.length>20 || clauses.some(c=>!c.title||!c.body.join(" ")))return null;
  const allClauseText=clauses.map(c=>c.title+" "+c.body.join(" ")).join(" ");
  if(allClauseText.length<55)return null;

  return {
    number,date,car,clientName,phone:phoneValue,workCount,works:jobs,
    total,clauses:clauses.map(c=>({title:c.title,body:normalize(c.body.join(" "))})),
    photoTop:carLabel.y-23+11
  };
}

const el=(tag,cls,text) => {
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(text!==undefined)node.textContent=text;
  return node;
};
const money=n=>new Intl.NumberFormat("ru-RU",{minimumFractionDigits:Number.isInteger(n)?0:2,maximumFractionDigits:2}).format(n)+" ₽";
const photoCrop=(canvas,top,left,width,height,scale)=> {
  const crop=document.createElement("canvas");
  crop.width=Math.round(width*scale);crop.height=Math.round(height*scale);
  const ctx=crop.getContext("2d",{alpha:false});
  ctx.drawImage(canvas,left*scale,top*scale,crop.width,crop.height,0,0,crop.width,crop.height);
  return crop;
};

async function imageCrops(pdf, photoTop) {
  const page=await pdf.getPage(1),scale=1.75;
  const canvas=document.createElement("canvas");
  const vp=page.getViewport({scale});
  canvas.width=Math.round(vp.width);canvas.height=Math.round(vp.height);
  const ctx=canvas.getContext("2d",{alpha:false});
  await page.render({canvasContext:ctx,canvas,viewport:vp}).promise;
  const brand=photoCrop(canvas,60,32,531,76,scale).toDataURL("image/png");
  const picture=photoCrop(canvas,photoTop,397,154,144,scale);
  const pctx=picture.getContext("2d",{willReadFrequently:true});
  const {data}=pctx.getImageData(0,0,picture.width,picture.height);
  let min=255,max=0;
  for(let y=10;y<picture.height-10;y+=17)for(let x=10;x<picture.width-10;x+=17){
    const i=(y*picture.width+x)*4;
    const value=Math.round((data[i]+data[i+1]+data[i+2])/3);
    min=Math.min(min,value);max=Math.max(max,value);
  }
  return {brand,photo:max-min>55?picture.toDataURL("image/jpeg",.86):null};
}


/**
 * Accessible photo zoom with its own browser history entry.
 * Android's Back gesture pops that entry and closes the image instead of
 * leaving the estimate. Closing with X, backdrop, picture or Escape uses the
 * same history entry. The visible URL/hash never changes.
 */
export function attachPhotoLightbox(pic,{win=window,doc=document}={}) {
  const overlay=doc.createElement("div");
  overlay.className="m-photo-overlay";
  overlay.hidden=true;
  overlay.setAttribute("role","dialog");
  overlay.setAttribute("aria-modal","true");
  overlay.setAttribute("aria-label","Фотография автомобиля");
  const closeButton=doc.createElement("button");
  closeButton.className="m-photo-close";
  closeButton.type="button";
  closeButton.textContent="×";
  closeButton.setAttribute("aria-label","Закрыть фотографию");
  const large=doc.createElement("img");
  large.src=pic.src;
  large.alt="Фотография автомобиля крупно";
  overlay.append(large,closeButton);
  doc.body.append(overlay);

  pic.setAttribute("role","button");
  pic.setAttribute("tabindex","0");
  pic.setAttribute("aria-label","Увеличить фотографию");

  let previousFocus=null,previousOverflow=null,historyArmed=false;
  const historyKey="__expertPhotoOpen";
  function hide(){
    if(overlay.hidden)return;
    overlay.hidden=true;
    doc.body.style.overflow=previousOverflow ?? "";
    historyArmed=false;
    previousFocus?.focus?.({preventScroll:true});
    previousFocus=null;
  }
  function open(){
    if(!overlay.hidden)return;
    previousFocus=doc.activeElement;
    previousOverflow=doc.body.style.overflow;
    overlay.hidden=false;
    doc.body.style.overflow="hidden";
    // Use the *same* #id=<token> URL: there is no extra network request or
    // change to the customer's existing PDF access token.
    try {
      win.history.pushState({[historyKey]:true},"",win.location.href);
      historyArmed=true;
    } catch(_) {
      // In restricted embeds, X/tap-to-close still work.
      historyArmed=false;
    }
    closeButton.focus?.({preventScroll:true});
  }
  function close(){
    if(overlay.hidden)return;
    const popCurrent=historyArmed && win.history.state?.[historyKey]===true;
    hide();
    if(popCurrent)win.history.back();
  }
  pic.addEventListener("click",open);
  pic.addEventListener("keydown",event=>{
    if(event.key==="Enter" || event.key===" "){event.preventDefault();open();}
  });
  closeButton.addEventListener("click",close);
  large.addEventListener("click",close);
  overlay.addEventListener("click",event=>{if(event.target===overlay)close();});
  win.addEventListener("keydown",event=>{
    if(event.key==="Escape" && !overlay.hidden){event.preventDefault();close();}
  });
  win.addEventListener("popstate",()=>{
    // A system Back gesture consumes the overlay history entry.
    if(!overlay.hidden)hide();
  });
  return {open,close,overlay};
}

export async function buildMobileEstimate(pdf,host) {
  if(pdf.numPages>40)return false;
  const texts=[];
  for(let pageNo=1;pageNo<=pdf.numPages;pageNo++){
    const page=await pdf.getPage(pageNo);
    const content=await page.getTextContent();
    texts.push({lines:toLines(content,page.view[3])});
  }
  const model=parseEstimatePages(texts);
  if(!model)return false;
  let images={brand:null,photo:null};
  try{images=await imageCrops(pdf,model.photoTop)}catch{return false}
  const article=el("article","m-estimate");
  const header=el("div","m-meta");
  header.append(el("b",null,"СМЕТА №"+model.number),el("time",null,model.date));
  article.append(header);
  if(images.brand){
    const logo=el("img","m-banner");logo.alt="ЭКСПЕРТ · Кузовной сервис";logo.src=images.brand;
    article.append(logo);
  }
  article.append(el("h1",null,"Смета на кузовной ремонт"));
  article.append(el("p","m-desc","Состав работ и стоимость ремонта"));
  const card=el("section","m-car");
  let photoNode=null;
  const details=el("div","m-car-details");
  details.append(el("div","m-eyebrow","АВТОМОБИЛЬ"),el("h2",null,model.car));
  details.append(el("p",null,"Клиент: "+model.clientName));
  if(model.phone)details.append(el("p",null,"Телефон: "+model.phone));
  details.append(el("p","m-muted","Работ: "+model.workCount));
  card.append(details);
  if(images.photo){
    const pic=el("img","m-photo");pic.src=images.photo;pic.alt="Фото автомобиля";
    photoNode=pic;
    card.append(pic);
  }
  article.append(card,el("h2","m-section","Перечень работ"));
  const table=el("table","m-works"),thead=el("thead"),tr=el("tr");
  tr.append(el("th",null,"Работы"),el("th",null,"С материалами"));
  thead.append(tr);table.append(thead);
  const tbody=el("tbody");
  for(const item of model.works){
    const row=el("tr");
    row.append(el("td",null,String(item.number).padStart(2,"0")+"  "+item.label),el("td",null,money(item.price)));
    tbody.append(row);
  }
  table.append(tbody);article.append(table);
  const total=el("div","m-total");
  total.append(el("span",null,"Итого с материалами"),el("strong",null,money(model.total)));
  article.append(total,el("h2","m-section","Важные условия ремонта"));
  for(const clause of model.clauses){
    const box=el("section","m-clause");
    box.append(el("h3",null,clause.title),el("p",null,clause.body));
    article.append(box);
  }
  const foot=el("footer","m-foot","ЭКСПЕРТ · Кузовной сервис · Смета №"+model.number);
  article.append(foot);
  host.replaceChildren(article);
  if(photoNode)attachPhotoLightbox(photoNode);
  return true;
}
