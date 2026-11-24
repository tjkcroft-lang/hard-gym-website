// HARD GYM booking email notifications
// Supabase Edge Function: booking-notify
// Deploy with JWT verification OFF only because we validate the private webhook secret.
// NEVER place RESEND_API_KEY, SERVICE_ROLE_KEY or BOOKING_WEBHOOK_SECRET on the public website.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type HookPayload = { type?: string; record?: { id?: string }; };
const s = (v: unknown) => String(v ?? "");
const safe = (v: unknown) => s(v).replace(/[&<>"']/g, c =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c] ?? c
);
const format = (date: string) => new Intl.DateTimeFormat("en-AU",{
  timeZone:"Australia/Sydney",dateStyle:"full",timeStyle:"short"
}).format(new Date(date));
const serviceLabel: Record<string,string> = {
  one_on_one:"1-on-1 personal training",
  partner:"2-on-1 partner training",
  small_group:"private small-group training"
};

Deno.serve(async (request) => {
  if(request.method !== "POST") return new Response("Method not allowed",{status:405});
  const webhookSecret = Deno.env.get("BOOKING_WEBHOOK_SECRET");
  if(!webhookSecret || request.headers.get("x-hg-webhook-key") !== webhookSecret){
    return new Response("Unauthorized",{status:401});
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("BOOKING_FROM_EMAIL");
  const owner = Deno.env.get("BOOKING_OWNER_EMAIL");
  if(!supabaseUrl || !serviceKey || !resendKey || !from || !owner){
    return new Response("Notification settings incomplete",{status:503});
  }
  let payload: HookPayload;
  try{payload=await request.json()}catch{return new Response("Invalid JSON",{status:400})}
  const eventId = payload?.record?.id;
  if(!eventId || !/^[a-f0-9-]{36}$/i.test(eventId)){
    return new Response("Invalid event",{status:400});
  }

  const db = createClient(supabaseUrl,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:event,error:evError} = await db.from("hg_booking_events")
    .select("id,booking_id,event_type,owner_sent_at,client_sent_at")
    .eq("id",eventId).single();
  if(evError || !event)return new Response("Booking event not found",{status:404});
  const {data:booking,error:bookingError} = await db.from("hg_bookings")
    .select("id,status,partner_name,hg_profiles(display_name,email,phone),hg_slots(starts_at,ends_at,service,coach)")
    .eq("id",event.booking_id).single();
  if(bookingError||!booking)return new Response("Booking not found",{status:404});

  const profile = booking.hg_profiles as unknown as {display_name?:string;email?:string;phone?:string};
  const slot = booking.hg_slots as unknown as {starts_at:string;ends_at:string;service:string;coach:string};
  if(!profile?.email||!slot?.starts_at)return new Response("Missing booking details",{status:422});

  const isBooked = event.event_type === "booked";
  const service = serviceLabel[slot.service] || slot.service;
  const when = format(slot.starts_at);
  const subjectOwner = isBooked ? "HARD GYM: NEW PT BOOKING" : "HARD GYM: BOOKING CANCELLED";
  const subjectClient = isBooked ? "Your HARD GYM booking is confirmed" : "Your HARD GYM booking has been cancelled";
  const action = isBooked ? "confirmed" : "cancelled";
  const details = [
    "Session: "+service,
    "Time: "+when+" (Sydney time)",
    "Coach: "+slot.coach,
    ...(booking.partner_name ? ["Training partner: "+booking.partner_name] : [])
  ].join("\n");
  const ownerMessage = [
    "A HARD GYM booking was "+action+".",
    "Client: "+(profile.display_name||"Not supplied"),
    "Email: "+profile.email,
    "Phone: "+(profile.phone||"Not supplied"),
    details
  ].join("\n\n");
  const clientMessage = [
    "Hi "+(profile.display_name||"there")+",",
    "Your HARD GYM session is "+action+".",
    details,
    isBooked?"Manage your booking at https://www.hardgym.com.au/booking/":
      "If you need another time, log in to see the available sessions.",
    "NO BULL. JUST WORK."
  ].join("\n\n");
  const send = async(to:string,subject:string,text:string) => {
    const res = await fetch("https://api.resend.com/emails",{
      method:"POST",
      headers:{"Authorization":"Bearer "+resendKey,"Content-Type":"application/json"},
      body:JSON.stringify({
        from, to:[to], subject, text,
        html:'<div style="font-family:Arial,sans-serif;line-height:1.7;color:#181219;white-space:pre-wrap">'+safe(text)+'</div>'
      })
    });
    if(!res.ok)throw new Error("Email provider returned "+res.status+": "+(await res.text()).slice(0,220));
  };

  // Separate sent stamps prevent duplicate owner email if client delivery later fails.
  try{
    if(!event.owner_sent_at){
      await send(owner,subjectOwner,ownerMessage);
      const {error:markError} = await db.from("hg_booking_events")
        .update({owner_sent_at:new Date().toISOString(),delivery_error:null})
        .eq("id",event.id);
      if(markError)throw markError;
    }
    if(!event.client_sent_at){
      await send(profile.email,subjectClient,clientMessage);
      const {error:markError} = await db.from("hg_booking_events")
        .update({client_sent_at:new Date().toISOString(),delivery_error:null})
        .eq("id",event.id);
      if(markError)throw markError;
    }
    return new Response(JSON.stringify({ok:true}),{
      status:200,headers:{"Content-Type":"application/json"}
    });
  }catch(error){
    const message=s(error instanceof Error?error.message:error).slice(0,300);
    await db.from("hg_booking_events").update({delivery_error:message}).eq("id",event.id);
    return new Response("Delivery failed: "+message,{status:502});
  }
});
