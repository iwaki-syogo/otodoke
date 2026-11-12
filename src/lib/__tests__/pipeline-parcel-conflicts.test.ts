import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processInboundEmail } from "@/lib/pipeline";
import type { AdminClient } from "@/lib/supabase/admin";
import { FakeDb, type Result } from "./fake-db";
import { USER, asConsentingAdmin as asAdmin, item, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

const mocks = vi.hoisted(() => ({ extract: vi.fn(), triage: vi.fn() }));
vi.mock("@/lib/extract/extract", () => ({ extractEmail: mocks.extract }));
vi.mock("@/lib/extract/triage", () => ({ isPurchaseMail: mocks.triage }));
const ORDER = "ORDER-12345678";

/** Preserve lazy request headers while delaying or changing a synthetic RPC reply. */
function rpcResult(query: Promise<Result>, work: (source: Promise<Result>) => Promise<Result> = async (source) => source): Promise<Result> {
  let started: Promise<Result> | undefined;
  const builder = {
    setHeader(key: string, value: string) {
      const setter = (query as Promise<Result> & { setHeader?: (key: string, value: string) => unknown }).setHeader;
      if (setter) setter.call(query, key, value);
      return builder;
    },
    then(resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) {
      started ??= work(query);
      return started.then(resolve, reject);
    },
  };
  return builder as unknown as Promise<Result>;
}
const incoming = (id: string, sentAt = "2026-11-12T00:00:00Z") => ({ ...mailOf(sentAt), providerEmailId: `provider-${id}`, messageId: `<${id}@example.test>`, text: "テスト本文\nSynthetic item\n根拠の行" });

beforeEach(() => {
  mocks.extract.mockReset(); mocks.triage.mockReset();
  vi.stubGlobal("fetch", () => { throw new Error("external fetch is forbidden in parcel conflict tests"); });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("different mails filing the same parcel", () => {
  it("B1: concurrent distinct mails for one order keep one parcel and one 1000-yen expense", async () => {
    const db = new FakeDb();
    const extracted = precomputed(reading({ relevance: "order", order_number: sure(ORDER), total_amount: sure(1000), items: [item("Synthetic item", 1000)] }));
    const outcomes = await Promise.all([
      processInboundEmail(asAdmin(db), incoming("first"), { precomputed: extracted }),
      processInboundEmail(asAdmin(db), incoming("second"), { precomputed: extracted }),
    ]);
    expect(outcomes.map((o) => o.kind)).toEqual(["processed", "processed"]);
    expect({ parcels: db.rows("parcels").length, expense: db.rows("parcels").reduce((n,p) => n + Number(p.total_amount),0) }).toEqual({ parcels: 1, expense: 1000 });
    expect(db.rows("parcel_items")).toHaveLength(1);
    expect(db.rows("extractions")).toHaveLength(2);
    expect(new Set(db.rows("extractions").map((e) => e.parcel_id)).size).toBe(1);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.triage).not.toHaveBeenCalled();
  });

  it("B2: a delayed shipping write recomputes after delivery and preserves the person's received date and category", async () => {
    const db = new FakeDb({ parcels: [{ id: "shared-parcel", user_id: USER, shop: "Synthetic shop", shop_key: "other", order_number: ORDER,
      status: "ordered", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", last_email_at: "2026-11-01T00:00:00Z" }] });
    let arrived!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    let held = false;
    const client = new Proxy(asAdmin(db), {
      get(target, property) {
        if (property === "rpc") return (name: string, args: unknown) => rpcResult(db.rpc(name, args), async (query) => {
          const a = args as { p_table?: string; p_operation?: string; p_values?: { status?: string } };
          if (!held && (name === "mail_run_write" && a.p_table === "parcels" && a.p_operation === "update" || name === "update_mail_parcel") && a.p_values?.status === "shipped") {
            held = true; arrived(); await resume;
          }
          const result = await query;
          // The real parcels_received_at trigger clears this when delivered is reverted.
          const parcel = db.find("parcels", "shared-parcel");
          if (parcel && parcel.status !== "delivered") parcel.received_at = null;
          return result;
        });
        const value = Reflect.get(target,property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AdminClient;
    const shipping = processInboundEmail(client, incoming("shipping", "2026-11-12T00:00:00Z"), {
      precomputed: precomputed(reading({ relevance: "shipped", order_number: sure(ORDER), expected_date: sure("2026-11-15"), category: "hobby" })),
    });
    await waiting;
    try {
      expect((await processInboundEmail(asAdmin(db), incoming("delivered", "2026-11-12T01:00:00Z"), {
        precomputed: precomputed(reading({ relevance: "delivered", order_number: sure(ORDER), expected_date: sure("2026-11-14") })),
      })).kind).toBe("processed");
      Object.assign(db.find("parcels", "shared-parcel")!, { received_at: "2026-11-12T01:05:00.000Z", category: "beauty", category_source: "user", expected_date: "2026-11-19", updated_at: db.tick() });
    } finally { release(); }
    expect((await shipping).kind).toBe("processed");
    expect(db.find("parcels", "shared-parcel")).toMatchObject({
      status: "delivered", received_at: "2026-11-12T01:05:00.000Z", last_email_at: "2026-11-12T01:00:00Z",
      expected_date: "2026-11-19", category: "beauty", category_source: "user",
    });
    expect(db.rows("extractions")).toHaveLength(2);
    expect(mocks.extract).not.toHaveBeenCalled();
  });
  it("B1: a stale soft match reselects the newly created exact-order parcel", async () => {
    const db = new FakeDb({ parcels:[{ id:"carrier",user_id:USER,shop:"テスト店",shop_key:"other",status:"shipped",tracking_number:"123456789012",
      order_number:null,title:"Long synthetic item A",created_at:"2026-11-01T00:00:00Z",updated_at:"2026-11-01T00:00:00Z",last_email_at:"2026-11-01T00:00:00Z" }],
      parcel_items:[{id:"carrier-item",user_id:USER,parcel_id:"carrier",name:"Long synthetic item A"}] });
    let arrived!:()=>void; let release!:()=>void;
    const waiting=new Promise<void>((r)=>{arrived=r;}); const resume=new Promise<void>((r)=>{release=r;}); let held=false;
    const client=new Proxy(asAdmin(db),{get(target,key){
      if(key==="rpc") return (name:string,args:unknown)=>rpcResult(db.rpc(name,args),async(query)=>{
        const a=args as {p_table?:string;p_parcel_id?:string;p_values?:{order_number?:string}};
        if(!held && ["mail_run_write","update_mail_parcel"].includes(name) && a.p_values?.order_number===ORDER && (a.p_table==="parcels" || a.p_parcel_id==="carrier")) {held=true;arrived();await resume;}
        return query;
      });
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }}) as AdminClient;
    const body="テスト本文\n根拠の行\nLong synthetic item A\nLong synthetic item B";
    const first=processInboundEmail(client,{...incoming("soft-payment"),text:body},{precomputed:precomputed(reading({relevance:"payment",order_number:sure(ORDER),items:[item("Long synthetic item A",1000)],total_amount:sure(1000)}))});
    await waiting;
    try { await processInboundEmail(asAdmin(db),{...incoming("exact-order"),text:body},{precomputed:precomputed(reading({relevance:"order",order_number:sure(ORDER),items:[item("Long synthetic item B",1000)],total_amount:sure(1000)}))}); }
    finally { release(); }
    expect((await first).kind).toBe("processed");
    expect(db.rows("parcels").filter((p)=>p.order_number===ORDER)).toHaveLength(1);
    expect(db.find("parcels","carrier")!.order_number).toBeNull();
    expect(new Set(db.rows("extractions").map((e)=>e.parcel_id)).size).toBe(1);
  });

  it("B1: an itemNames-only change invalidates a new-parcel snapshot", async () => {
    const db=new FakeDb({parcels:[{id:"old",user_id:USER,shop:"テスト店",shop_key:"other",status:"shipped",updated_at:"2026-11-01T00:00:00Z"}],parcel_items:[{id:"old-item",user_id:USER,parcel_id:"old",name:"Before item"}]});
    const rpc=db.rpc.bind(db);let attempts=0;
    db.rpc=(name,args)=>{
      if(name==="create_mail_parcel" && ++attempts===1) db.rows("parcel_items")[0].name="After item";
      return rpc(name,args);
    };
    expect((await processInboundEmail(asAdmin(db),incoming("item-change"),{precomputed:precomputed(reading({relevance:"order",order_number:sure(ORDER)}))})).kind).toBe("processed");
    expect(attempts).toBe(2);
    expect(db.rows("parcel_items")[0].name).toBe("After item");
  });

  it("B1: bounded repeated conflicts keep the mail unread and retain the paid evidence", async () => {
    const db=new FakeDb();const rpc=db.rpc.bind(db);let attempts=0;
    db.rpc=(name,args)=>{
      if(name==="create_mail_parcel") {attempts++;db.rpcCalls.push({name,args});return rpcResult(Promise.resolve({data:[{verdict:"retry",parcel_id:null}],error:null}));}
      return rpc(name,args);
    };
    await expect(processInboundEmail(asAdmin(db),incoming("busy"),{precomputed:precomputed(reading({relevance:"order",order_number:sure(ORDER)}))})).rejects.toThrow("not merged yet");
    expect(attempts).toBe(4);
    expect(db.rows("emails")[0]).toMatchObject({processing_status:"failed",body_state:"plain"});
    expect(db.rows("emails")[0].text_body).toContain("根拠の行");
    expect(db.rows("extractions")).toMatchObject([{parcel_id:null,model:"test-model"}]);
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it("B1: first-item failure rolls back the new parcel and leaves the mail recoverable", async () => {
    const db=new FakeDb();
    db.hooks.push((q)=>q.table==="parcel_items"&&q.op==="insert"?{data:null,error:{code:"23514",message:"synthetic item failure"}}:undefined);
    await expect(processInboundEmail(asAdmin(db),incoming("item-failure"),{precomputed:precomputed(reading({relevance:"order",order_number:sure(ORDER),items:[item("Synthetic item",1000)]}))})).rejects.toThrow("synthetic item failure");
    expect(db.rows("parcels")).toEqual([]);
    expect(db.rows("parcel_items")).toEqual([]);
    expect(db.rows("emails")[0]).toMatchObject({processing_status:"failed",body_state:"plain"});
  });

  it("B1: short identical order numbers at different shops and distinct orders remain valid", async () => {
    const db=new FakeDb();
    for(const [id,shop,order] of [["shop-a","Synthetic shop A","1001"],["shop-b","Synthetic shop B","1001"],["another-order","Synthetic shop A","1002"]]) {
      expect((await processInboundEmail(asAdmin(db),incoming(id),{precomputed:precomputed(reading({relevance:"order",shop_name:shop,order_number:sure(order)}))})).kind).toBe("processed");
    }
    expect(db.rows("parcels")).toHaveLength(3);
  });

  it("B2: accepts a PostgreSQL time readback with seconds after sending HH:MM", async () => {
    const db=new FakeDb({parcels:[{id:"timed",user_id:USER,shop:"テスト店",shop_key:"other",status:"ordered",order_number:ORDER,updated_at:"2026-11-01T00:00:00Z"}]});
    const rpc=db.rpc.bind(db);
    db.rpc=(name,args)=>rpcResult(rpc(name,args),async(query)=>{
      const result=await query;
      if(name==="update_mail_parcel" && Array.isArray(result.data)) {
        const row=result.data[0]?.parcel_row as Record<string,unknown>|undefined;
        if(row?.expected_window_start==="12:34") {row.expected_window_start="12:34:00";db.find("parcels","timed")!.expected_window_start="12:34:00";}
      }
      return result;
    });
    expect((await processInboundEmail(asAdmin(db),incoming("time-readback"),{precomputed:precomputed(reading({relevance:"shipped",order_number:sure(ORDER),expected_date:sure("2026-11-15"),expected_window_start:sure("12:34")}))})).kind).toBe("processed");
    expect(db.find("parcels","timed")!.expected_window_start).toBe("12:34:00");
  });

  it("B2: a delayed total recomputes every saved extraction after a conflicting total write", async () => {
    const db=new FakeDb({parcels:[{id:"total",user_id:USER,shop:"テスト店",shop_key:"other",status:"ordered",order_number:ORDER,updated_at:"2026-11-01T00:00:00Z"}]});
    const rpc=db.rpc.bind(db);let arrived!:()=>void;let release!:()=>void;let held=false;
    const waiting=new Promise<void>((r)=>{arrived=r;});const resume=new Promise<void>((r)=>{release=r;});
    db.rpc=(name,args)=>rpcResult(rpc(name,args),async(query)=>{
      const a=args as {p_table?:string;p_values?:{total_amount?:number}};
      if(!held && name==="mail_run_write" && a.p_table==="parcels" && a.p_values?.total_amount===1000) {held=true;arrived();await resume;}
      return query;
    });
    const first=processInboundEmail(asAdmin(db),incoming("total-old"),{precomputed:precomputed(reading({relevance:"shipped",order_number:sure(ORDER),total_amount:sure(1000)}))});
    await waiting;
    try { await processInboundEmail(asAdmin(db),incoming("total-new","2026-11-12T01:00:00Z"),{precomputed:precomputed(reading({relevance:"shipped",order_number:sure(ORDER),total_amount:sure(2000)}))}); }
    finally {release();}
    expect((await first).kind).toBe("processed");
    expect(db.find("parcels","total")!.total_amount).toBe(3000);
    expect(db.rows("extractions")).toHaveLength(2);
  });

  it("B1: a database deadlock is a visible failure and the same mail can recover", async () => {
    const db=new FakeDb();const rpc=db.rpc.bind(db);let failed=false;
    db.rpc=(name,args)=>{
      if(name==="create_mail_parcel"&&!failed){failed=true;return rpcResult(Promise.resolve({data:null,error:{code:"40P01",message:"deadlock detected"}}));}
      return rpc(name,args);
    };
    const options={precomputed:precomputed(reading({relevance:"order",order_number:sure(ORDER)}))};
    await expect(processInboundEmail(asAdmin(db),incoming("deadlock"),options)).rejects.toThrow("deadlock detected");
    expect(db.rows("emails")[0]).toMatchObject({processing_status:"failed",body_state:"plain"});
    expect((await processInboundEmail(asAdmin(db),incoming("deadlock"),options)).kind).toBe("processed");
    expect(db.rows("emails")).toHaveLength(1);
  });
  it("B2: the total includes an amount stated only after the first 1000 extractions", async () => {
    const db=new FakeDb({parcels:[{id:"many-readings",user_id:USER,shop:"テスト店",shop_key:"other",status:"ordered",order_number:ORDER,updated_at:"2026-11-01T00:00:00Z"}],
      extractions:Array.from({length:1001},(_,n)=>({id:`reading-${String(n).padStart(4,"0")}`,user_id:USER,email_id:`old-mail-${n}`,parcel_id:"many-readings",result:reading(n===1000?{relevance:"payment",total_amount:sure(7654)}:{relevance:"payment"})}))});
    expect((await processInboundEmail(asAdmin(db),incoming("many-readings"),{precomputed:precomputed(reading({relevance:"payment",order_number:sure(ORDER)}))})).kind).toBe("processed");
    expect(db.find("parcels","many-readings")!.total_amount).toBe(7654);
    expect(db.callsOn("extractions","select").some((q)=>q.range?.[0]===1000)).toBe(true);
  });

  it("B2: a first-item failure rolls back an existing parcel's status and category", async () => {
    const db=new FakeDb({parcels:[{id:"update-failure",user_id:USER,shop:"テスト店",shop_key:"other",status:"ordered",order_number:ORDER,updated_at:"2026-11-01T00:00:00Z"}]});
    const before=structuredClone(db.rows("parcels"));
    db.hooks.push((q)=>q.table==="parcel_items"&&q.op==="insert"?{data:null,error:{code:"23514",message:"synthetic update item failure"}}:undefined);
    await expect(processInboundEmail(asAdmin(db),incoming("update-item-failure"),{precomputed:precomputed(reading({relevance:"shipped",order_number:sure(ORDER),category:"hobby",items:[item("Synthetic item",1000)]}))})).rejects.toThrow("synthetic update item failure");
    expect(db.rows("parcels")).toEqual(before);
    expect(db.rows("parcel_items")).toEqual([]);
    expect(db.rows("emails")[0]).toMatchObject({processing_status:"failed",body_state:"plain"});
  });

  it("B1: item-name matching reads past the first 1000 item rows", async () => {
    const name="Long synthetic matching item";
    const db=new FakeDb({parcels:[{id:"many-items",user_id:USER,shop:"テスト店",shop_key:"other",status:"shipped",created_at:new Date().toISOString(),updated_at:"2026-11-01T00:00:00Z"}],
      parcel_items:Array.from({length:1001},(_,n)=>({id:`item-${String(n).padStart(4,"0")}`,user_id:USER,parcel_id:"many-items",name:n===1000?name:`Unrelated item ${n}`}))});
    expect((await processInboundEmail(asAdmin(db),{...incoming("many-items"),text:`テスト本文\n根拠の行\n${name}`},{precomputed:precomputed(reading({relevance:"payment",items:[item(name,1000)]}))})).kind).toBe("processed");
    expect(db.rows("parcels")).toHaveLength(1);
    expect(db.rows("parcel_items")).toHaveLength(1001);
    expect(db.callsOn("parcel_items","select").some((q)=>q.range?.[0]===1000)).toBe(true);
  });

  it("B1: an unreadable item snapshot fails before creating or attaching any parcel", async () => {
    const db=new FakeDb({parcels:[{id:"known",user_id:USER,shop:"テスト店",shop_key:"other",status:"ordered",order_number:ORDER,updated_at:"2026-11-01T00:00:00Z"}]});
    db.hooks.push((q)=>q.table==="parcel_items"&&q.op==="select"?{data:[],error:null,count:null}:undefined);
    await expect(processInboundEmail(asAdmin(db),incoming("bad-items"),{precomputed:precomputed(reading({relevance:"payment",order_number:sure(ORDER)}))})).rejects.toThrow("query did not return a count");
    expect(db.find("parcels","known")!.status).toBe("ordered");
    expect(db.rows("extractions")).toHaveLength(0);
    expect(db.rows("emails")[0]).toMatchObject({processing_status:"failed",body_state:"plain"});
  });

});
