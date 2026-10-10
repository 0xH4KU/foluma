import assert from "node:assert/strict";
import {test} from "node:test";
import {flushMetadata, type MetadataDraft} from "../desktop/metadata.ts";
import type {Book, Metadata} from "../sdk/types.ts";

test("metadata commits serialize save/blur, keep newer input and retain failed edits", async () => {
  let book = {id:"book",revision:0,metadata:{title:"Before",author:""}} as Book;
  const requests: {revision:number; values:Partial<Metadata>; resolve:()=>void; reject:(error:Error)=>void}[] = [];
  const host = {getDocument:()=>book,apply:async (current:Book,changes:{metadata?:Partial<Metadata>}) => {
    await new Promise<void>((resolve,reject)=>requests.push({revision:current.revision,values:changes.metadata!,resolve,reject}));
    book = {...book,revision:book.revision+1,metadata:{...book.metadata,...changes.metadata}};
    return book;
  }};
  const draft: MetadataDraft = {bookId:"book",values:{title:"After"},pending:null};
  const committed = flushMetadata(host,draft,()=>{});
  const save = flushMetadata(host,draft,()=>{});
  assert.equal(requests.length,1,"blur and Save must share the same commit");
  draft.values = {...draft.values,author:"New author"};
  requests[0].resolve();
  await committed;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,2);
  assert.equal(requests[1].revision,1,"next commit must use the latest document revision");
  assert.deepEqual(requests[1].values,{author:"New author"});
  requests[1].reject(new Error("disk full"));
  await assert.rejects(save,/disk full/);
  assert.deepEqual(draft.values,{author:"New author"},"failed input must stay available to retry");
  const retry = flushMetadata(host,draft,()=>{});
  requests[2].resolve(); await retry;
  assert.equal(book.metadata.title,"After");
  assert.equal(book.metadata.author,"New author");
  assert.deepEqual(draft.values,{});
  draft.bookId = "other"; draft.values = {title:"Keep me"};
  await assert.rejects(flushMetadata(host,draft,()=>{}),/another book/);
  assert.equal(draft.values.title,"Keep me");
});

test("several field blurs waiting for a save do not submit the same revision twice", async () => {
  let book = {id:"book",revision:0,metadata:{title:"Before",author:""}} as Book;
  const requests: {revision:number; resolve:()=>void}[] = [];
  const host = {getDocument:()=>book,apply:async (current:Book,changes:{metadata?:Partial<Metadata>}) => {
    await new Promise<void>((resolve)=>requests.push({revision:current.revision,resolve}));
    book = {...book,revision:book.revision+1,metadata:{...book.metadata,...changes.metadata}};
    return book;
  }};
  const draft: MetadataDraft = {bookId:"book",values:{title:"After"},pending:null};
  const first = flushMetadata(host,draft,()=>{});
  draft.values = {...draft.values,author:"Typed during save"};
  const second = flushMetadata(host,draft,()=>{}), third = flushMetadata(host,draft,()=>{});
  requests[0].resolve();
  await first;
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests.map(request=>request.revision),[0,1]);
  requests[1].resolve();
  await Promise.all([second,third]);
  assert.equal(requests.length,2);
  assert.equal(book.metadata.author,"Typed during save");
  assert.deepEqual(draft.values,{});
});
