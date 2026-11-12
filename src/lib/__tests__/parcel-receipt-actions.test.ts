import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processInboundEmail } from "@/lib/pipeline";
import type { AdminClient } from "@/lib/supabase/admin";
import { asConsentingAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";
import { FakeDb, type Result } from "./fake-db";

const USER="00000000-0000-4000-8000-000000000001";
const ID="00000000-0000-4000-8000-000000000010";
const state=vi.hoisted(()=>({db:null as unknown,userId:"00000000-0000-4000-8000-000000000001" as string|null,authReadThrows:false}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createClient:async()=>Object.assign(state.db as FakeDb,{auth:{getUser:async()=>{if(state.authReadThrows)throw new Error("synthetic auth read failure");return {data:{user:state.userId?{id:state.userId}:null},error:null};}}})}));
const {markDeliveredForUndo,restoreStatuses,markNotReceived}=await import("@/app/app/parcel-actions");
const row=(status="shipped")=>({id:ID,user_id:USER,shop:"Synthetic shop",status,received_at:null,updated_at:"2026-11-01T00:00:00Z",created_at:"2026-11-01T00:00:00Z"});

beforeEach(()=>{state.userId=USER;state.authReadThrows=false;state.db=new FakeDb();vi.stubGlobal("fetch",()=>{throw new Error("external fetch is forbidden in receipt tests");});});
afterEach(()=>{vi.unstubAllGlobals();});

describe("server-owned receipt undo",()=>{
  it("B1: a stale tab cannot undo the delivery mail that arrived before the receive press",async()=>{
    const db=new FakeDb({parcels:[row("delivered")]});state.db=db;
    const marked=await markDeliveredForUndo([ID]);
    expect(marked.written).toHaveLength(1);
    const receipt=marked.written[0];
    // The caller still has the old rendered shipped state. It is never the undo authority.
    const stale={...receipt,status:"shipped",received_at:null,written_at:receipt.received_at};
    await restoreStatuses([stale]);
    expect(db.find("parcels",ID)).toMatchObject({status:"delivered",received_at:null});
  });

  it("B1: a delivery mail after receiving changes the version and keeps its delivered result on undo",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;
    const marked=await markDeliveredForUndo([ID]);
    const receipt=marked.written[0];
    await db.from("parcels").update({status:"delivered",last_email_at:"2026-11-12T01:00:00Z"}).eq("id",ID);
    const prior=structuredClone(db.find("parcels",ID));
    const undo={...receipt,status:"shipped",received_at:null,written_at:receipt.received_at};
    const result=await restoreStatuses([undo]);
    expect(db.find("parcels",ID)).toEqual(prior);
    expect(result).toMatchObject({restored:[],changed:[ID],failed:[]});
  });

  it("B2: an expired session is failed rather than claiming a parcel stayed received",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;
    const marked=await markDeliveredForUndo([ID]);
    const receipt=marked.written[0];state.userId=null;
    const undo={...receipt,status:"shipped",received_at:null,written_at:receipt.received_at};
    expect(await restoreStatuses([undo])).toEqual({restored:[],changed:[],failed:[ID]});
    expect(db.rpcCalls.filter((call)=>call.name==="restore_parcel_receipts")).toEqual([]);
  });

  it("an auth read throw before the restore RPC is a known refusal and leaves the row unchanged",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;const marked=await markDeliveredForUndo([ID]);
    const before=structuredClone(db.find("parcels",ID));state.authReadThrows=true;
    const answer=await restoreStatuses(marked.written);
    expect(db.rpcCalls.filter((call)=>call.name==="restore_parcel_receipts")).toEqual([]);
    expect(db.find("parcels",ID)).toEqual(before);
    expect(answer).toEqual({restored:[],changed:[],failed:[ID]});
  });
  it("B1: a no-op delivery mail invalidates undo before its extraction is saved", async()=>{
    const order="RECEIPT-ORDER-123";
    const db=new FakeDb({parcels:[{...row(),shop:"テスト店",shop_key:"other",order_number:order,last_email_at:"2026-11-12T02:00:00Z",category:"hobby",category_source:"user"}]});state.db=db;
    db.rows("ai_reading_consents").push({user_id:USER,decision:"granted",decided_at:"2026-11-01T00:00:00Z",text_version:"test"});
    const marked=await markDeliveredForUndo([ID]);
    let arrived!:()=>void;let release!:()=>void;let held=false;
    const waiting=new Promise<void>((resolve)=>{arrived=resolve;});const resume=new Promise<void>((resolve)=>{release=resolve;});
    const target=asConsentingAdmin(db);
    const client=new Proxy(target,{get(target,key){
      if(key==="rpc") return (name:string,args:unknown)=>{
        const query=db.rpc(name,args) as Promise<Result> & {setHeader:(key:string,value:string)=>unknown};
        const builder={
          setHeader(key:string,value:string) {query.setHeader(key,value);return builder;},
          then:async(resolve:(value:Result)=>unknown,reject:(reason:unknown)=>unknown)=>{
            const a=args as {p_table?:string;p_operation?:string;p_values?:Record<string,unknown>};
            if(!held && name==="mail_run_write"&&a.p_table==="extractions"&&a.p_operation==="insert") {held=true;arrived();await resume;}
            return query.then(resolve,reject);
          },
        };
        return builder;
      };
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }}) as AdminClient;
    const pending=processInboundEmail(client,{...mailOf("2026-11-12T01:00:00Z"),userId:USER,messageId:"<receipt-noop@example.test>",providerEmailId:"receipt-noop"},{precomputed:precomputed(reading({relevance:"delivered",order_number:sure(order)}))});
    await Promise.race([waiting,pending.then(()=>{throw new Error("mail completed before extraction barrier");})]);
    try {
      const writes=db.rpcCalls.filter((call)=>call.name==="update_mail_parcel");
      expect(writes).toHaveLength(1);
      expect((writes[0].args as {p_values:unknown}).p_values).toEqual({});
      expect(await restoreStatuses(marked.written)).toEqual({restored:[],changed:[ID],failed:[]});
      expect(db.find("parcels",ID)).toMatchObject({status:"delivered",received_at:marked.written[0].received_at});
    } finally {release();}
    expect((await pending).kind).toBe("processed");
    expect(db.callsOn("emails","insert")[0].requestHeaders).toMatchObject({"x-otodoke-sample-user":USER,"x-otodoke-sample-generation":expect.any(String)});
    expect(db.find("parcels",ID)!.status).toBe("delivered");
  });

  it.each(["category", "expected_date", "status"])("keeps another %s edit and reports changed",async(field)=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;
    const mark=await markDeliveredForUndo([ID]);
    await db.from("parcels").update({[field]:field==="status"?"cancelled":field==="category"?"hobby":"2026-11-20"}).eq("id",ID);
    const current=structuredClone(db.find("parcels",ID));
    expect(await restoreStatuses(mark.written)).toEqual({restored:[],changed:[ID],failed:[]});
    expect(db.find("parcels",ID)).toEqual(current);
  });

  it("a newer receive replaces one bounded journal row and fences the older undo",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;
    const first=await markDeliveredForUndo([ID]);
    expect(await markNotReceived(ID)).toMatchObject({ok:true});
    const second=await markDeliveredForUndo([ID]);
    expect(second.written[0].receipt_id).not.toBe(first.written[0].receipt_id);
    expect(db.rows("parcel_receipt_undos")).toHaveLength(1);
    expect(await restoreStatuses(first.written)).toEqual({restored:[],changed:[ID],failed:[]});
    expect(await restoreStatuses(second.written)).toEqual({restored:[ID],changed:[],failed:[]});
    const version=db.find("parcels",ID)!.updated_at;
    expect(await restoreStatuses(second.written)).toEqual({restored:[ID],changed:[],failed:[]});
    expect(db.find("parcels",ID)!.updated_at).toBe(version);
  });

  it.each(["delete", "clear"])("%s removes journal authority and an old undo is changed",async(kind)=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;
    const marked=await markDeliveredForUndo([ID]);
    if(kind==="delete") await db.from("parcels").delete().eq("id",ID);
    else await db.rpc("clear_all_parcels",{p_user_id:USER});
    expect(db.rows("parcel_receipt_undos")).toEqual([]);
    expect(await restoreStatuses(marked.written)).toEqual({restored:[],changed:[ID],failed:[]});
    expect(db.rows("parcels")).toEqual([]);
  });

  it("B4: raw 201 repeated entries are rejected before authentication or RPC",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;
    await expect(markDeliveredForUndo(Array(201).fill(ID))).rejects.toThrow("too many");
    await expect(restoreStatuses(Array(201).fill({id:ID,receipt_id:ID}))).rejects.toThrow("too many");
    expect(db.rpcCalls).toEqual([]);expect(db.calls).toEqual([]);
    expect(db).not.toHaveProperty("auth");
  });

  it("empty requests are no-ops, invalid ids are omitted and duplicate valid ids count once",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;
    expect(await markDeliveredForUndo([])).toEqual({saved:0,written:[]});
    expect(await restoreStatuses([])).toEqual({restored:[],changed:[],failed:[]});
    expect(db.rpcCalls).toEqual([]);
    const marked=await markDeliveredForUndo([ID,ID,"invalid"]);
    expect(marked.saved).toBe(1);expect(marked.written).toHaveLength(1);
    expect(db.rpcCalls[0].args).toEqual({p_ids:[ID]});
    expect(await restoreStatuses([...marked.written,...marked.written])).toEqual({restored:[ID],changed:[],failed:[]});
  });

  it("contradictory tokens fail just that id without granting undo",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;const marked=await markDeliveredForUndo([ID]);
    expect(await restoreStatuses([marked.written[0],{id:ID,receipt_id:crypto.randomUUID()}])).toEqual({restored:[],changed:[],failed:[ID]});
    expect(db.find("parcels",ID)!.received_at).not.toBeNull();
  });

  it("B2: an RPC error is unconfirmed and is not reported restored",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;const marked=await markDeliveredForUndo([ID]);
    const error=vi.spyOn(console,"error").mockImplementation(()=>{});
    db.hooks.push((q)=>q.table==="parcels"&&q.op==="update"?{data:null,error:{message:"synthetic db unavailable"}}:undefined);
    expect(await restoreStatuses(marked.written)).toEqual({restored:[],changed:[],failed:[],unconfirmed:[ID]});
    expect(db.find("parcels",ID)!.received_at).not.toBeNull();error.mockRestore();
  });

  it("B2: duplicated, unknown and missing response rows are unconfirmed without losing valid rows",async()=>{
    const ids=[ID,"00000000-0000-4000-8000-000000000011","00000000-0000-4000-8000-000000000012","00000000-0000-4000-8000-000000000013","00000000-0000-4000-8000-000000000014","00000000-0000-4000-8000-000000000015"];
    const db=new FakeDb({parcels:ids.map((id)=>({...row(),id}))});state.db=db;const marked=await markDeliveredForUndo(ids);
    db.rpc=async()=>({data:[{id:ids[0],outcome:"restored"},{id:ids[1],outcome:"changed"},{id:ids[2],outcome:"restored"},{id:ids[2],outcome:"changed"},{id:ids[3],outcome:"failed"},{id:ids[4],outcome:"unexpected"},{id:crypto.randomUUID(),outcome:"restored"}],error:null});
    expect(await restoreStatuses(marked.written)).toEqual({restored:[ids[0]],changed:[ids[1]],failed:[ids[3]],unconfirmed:[ids[2],ids[4],ids[5]]});
  });

  it("a single explicit failed row remains a known refusal with the legacy three-array shape",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;const marked=await markDeliveredForUndo([ID]);
    const before=structuredClone(db.find("parcels",ID));
    db.rpc=async()=>({data:[{id:ID,outcome:"failed"}],error:null});
    expect(await restoreStatuses(marked.written)).toEqual({restored:[],changed:[],failed:[ID]});
    expect(db.find("parcels",ID)).toEqual(before);
  });

  it.each([null,{}])("a non-array RPC reply %j is unconfirmed",async(data)=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;const marked=await markDeliveredForUndo([ID]);
    db.rpc=async()=>({data,error:null});
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try {expect(await restoreStatuses(marked.written)).toEqual({restored:[],changed:[],failed:[],unconfirmed:[ID]});}
    finally {log.mockRestore();}
  });

  it.each(["error","throw"] as const)("an undo committed before its reply was lost (%s) is unconfirmed, never a known refusal",async(failure)=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;const marked=await markDeliveredForUndo([ID]);
    const rpc=db.rpc.bind(db);
    db.rpc=async(name,args)=>{
      const answer=await rpc(name,args);
      if(name!=="restore_parcel_receipts")return answer;
      if(failure==="throw")throw new Error("synthetic lost reply");
      return {data:null,error:{message:"synthetic lost reply"}};
    };
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try {
      expect(await restoreStatuses(marked.written)).toEqual({restored:[],changed:[],failed:[],unconfirmed:[ID]});
      expect(db.find("parcels",ID)).toMatchObject({status:"shipped",received_at:null});
    } finally {log.mockRestore();}
  });

  it("a pre-RPC refusal stays failed when another requested receipt has an RPC error",async()=>{
    const id2="00000000-0000-4000-8000-000000000011";
    const db=new FakeDb({parcels:[row(),{...row(),id:id2}]});state.db=db;const marked=await markDeliveredForUndo([ID,id2]);
    const items=marked.written.map((item)=>item.id===ID?{...item,receipt_id:"invalid"}:item);
    db.rpc=async()=>({data:null,error:{message:"synthetic RPC error"}});
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try {expect(await restoreStatuses(items)).toEqual({restored:[],changed:[],failed:[ID],unconfirmed:[id2]});}
    finally {log.mockRestore();}
  });

  it("a malformed mark receipt preserves another confirmed save without inventing undo",async()=>{
    const id2="00000000-0000-4000-8000-000000000011";
    const db=new FakeDb({parcels:[row(),{...row(),id:id2}]});state.db=db;
    const original=db.rpc.bind(db);
    db.rpc=async(name,args)=>{
      const result=await original(name,args);
      if(name==="mark_parcels_received"&&Array.isArray(result.data)) result.data[1].receipt_id="invalid";
      return result;
    };
    const mark=await markDeliveredForUndo([ID,id2]);
    expect(mark.saved).toBe(1);expect(mark.written.map((r)=>r.id)).toEqual([ID]);
    expect(db.rows("parcels").every((r)=>r.received_at!==null)).toBe(true);
  });

  it("a discarded receive write is not success and rolls back its journal",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;
    db.hooks.push((q)=>q.op==="update"?{data:[structuredClone(db.find("parcels",ID))],error:null}:undefined);
    await expect(markDeliveredForUndo([ID])).rejects.toThrow("not stored");
    expect(db.rows("parcel_receipt_undos")).toEqual([]);expect(db.find("parcels",ID)!.status).toBe("shipped");
  });

  it("a discarded undo write raises an unconfirmed RPC error and preserves the received row",async()=>{
    const db=new FakeDb({parcels:[row()]});state.db=db;const marked=await markDeliveredForUndo([ID]);
    const before=structuredClone(db.find("parcels",ID));
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    db.hooks.push((q)=>q.op==="update"?{data:[structuredClone(db.find("parcels",ID))],error:null}:undefined);
    expect(await restoreStatuses(marked.written)).toEqual({restored:[],changed:[],failed:[],unconfirmed:[ID]});
    expect(db.find("parcels",ID)).toEqual(before);log.mockRestore();
  });

  it("a mail confirmation whose version did not advance fails visibly and remains unread",async()=>{
    const order="RECEIPT-ORDER-124";
    const db=new FakeDb({parcels:[{...row(),shop:"テスト店",shop_key:"other",order_number:order,last_email_at:"2026-11-12T02:00:00Z",category:"hobby",category_source:"user"}],
      ai_reading_consents:[{user_id:USER,decision:"granted",decided_at:"2026-11-01T00:00:00Z",text_version:"test"}]});state.db=db;
    const marked=await markDeliveredForUndo([ID]);
    db.hooks.push((q)=>q.table==="parcels"&&q.op==="update"?{data:[structuredClone(db.find("parcels",ID))],error:null}:undefined);
    await expect(processInboundEmail(asConsentingAdmin(db),{...mailOf("2026-11-12T01:00:00Z"),userId:USER,messageId:"<receipt-no-version@example.test>",providerEmailId:"receipt-no-version"},
      {precomputed:precomputed(reading({relevance:"delivered",order_number:sure(order)}))})).rejects.toThrow("did not advance");
    expect(db.rows("emails")[0]).toMatchObject({processing_status:"failed"});
    expect(db.find("parcels",ID)).toMatchObject({status:"delivered",received_at:marked.written[0].received_at});
  });

});
