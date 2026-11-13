import test from "node:test";
import assert from "node:assert/strict";
import {attachPhotoLightbox} from "../mobile-reflow.mjs";

function environment() {
  const doc={activeElement:null};
  class Element {
    constructor(tag){this.tag=tag;this.attrs={};this.listeners={};this.style={overflow:""};this.children=[];this.hidden=false;this.src="";this.textContent="";}
    setAttribute(key,val){this.attrs[key]=val}
    append(...nodes){this.children.push(...nodes)}
    addEventListener(name,cb){(this.listeners[name]??=[]).push(cb)}
    dispatch(name,options={}){for(const cb of this.listeners[name]??[])cb({target:this,preventDefault(){},...options})}
    focus(){doc.activeElement=this}
  }
  doc.createElement=tag=>new Element(tag);
  doc.body=doc.createElement("body");
  const pic=doc.createElement("img");
  pic.src="data:image/jpeg;base64,/9j/";
  doc.activeElement=pic;

  const listeners={};
  const url="https://example.org/client.html#id="+"a".repeat(32);
  const win={
    location:{href:url},
    addEventListener(name,cb){(listeners[name]??=[]).push(cb)},
    history:{
      stack:[null],index:0,
      get state(){return this.stack[this.index]},
      pushState(state,unused,newUrl){
        assert.equal(newUrl,url,"photo zoom must preserve the customer link/hash");
        this.stack=this.stack.slice(0,this.index+1);
        this.stack.push(state);
        this.index++;
      },
      back(){
        if(this.index===0)throw Error("Back must not exit the estimate");
        this.index--;
        for(const cb of listeners.popstate??[])cb({state:this.state});
      }
    }
  };
  return {doc,pic,win,listeners};
}

test("photo zoom has accessible close and uses Back gesture without leaving the estimate",()=>{
  const {doc,pic,win}=environment();
  const zoom=attachPhotoLightbox(pic,{doc,win});
  assert.equal(zoom.overlay.hidden,true);
  pic.dispatch("click");
  assert.equal(zoom.overlay.hidden,false);
  assert.equal(win.history.index,1);
  assert.equal(zoom.overlay.children[1].attrs["aria-label"],"Закрыть фотографию");
  win.history.back(); // Android Back gesture
  assert.equal(zoom.overlay.hidden,true);
  assert.equal(win.history.index,0);
  assert.equal(doc.activeElement,pic);
});

test("X, backdrop, enlarged picture, Escape and Enter all work",()=>{
  const {doc,pic,win,listeners}=environment();
  const zoom=attachPhotoLightbox(pic,{doc,win});
  function verifyClose(closeAction) {
    pic.dispatch("click");
    assert.equal(zoom.overlay.hidden,false);
    closeAction();
    assert.equal(zoom.overlay.hidden,true);
    assert.equal(win.history.index,0,"closing image consumes the extra history entry");
  }
  verifyClose(()=>zoom.overlay.children[1].dispatch("click"));
  verifyClose(()=>zoom.overlay.dispatch("click",{target:zoom.overlay}));
  verifyClose(()=>zoom.overlay.children[0].dispatch("click"));
  verifyClose(()=>listeners.keydown.forEach(cb=>cb({key:"Escape",preventDefault(){}})));
  pic.dispatch("keydown",{key:"Enter"});
  assert.equal(zoom.overlay.hidden,false);
  zoom.close();
  assert.equal(zoom.overlay.hidden,true);
});
