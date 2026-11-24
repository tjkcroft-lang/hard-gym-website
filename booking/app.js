/* HARD GYM private booking portal. Supabase browser client: publishable key only.
   All bookings, permissions and remaining-place checks are enforced by SQL RLS/RPC.
   Never put the service role key, SMTP passwords or webhook secret in this file.
*/
(async function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const TZ = "Australia/Sydney";
  const config = window.HARD_GYM_BOOKING_CONFIG || {};
  const serviceNames = {
    one_on_one:"1-ON-1 PERSONAL TRAINING",
    partner:"2-ON-1 PARTNER TRAINING",
    small_group:"PRIVATE SMALL GROUP"
  };
  const state = {
    db:null,user:null,profile:null,settings:null,slots:[],myBookings:[],
    adminSlots:[],adminBookings:[],bookingSlot:null,recovery:false,loading:false
  };
  const safe = (v) => String(v ?? "").replace(/[&<>"']/g, (char) =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char])
  );
  function setVisible(id,visible){$(id).hidden=!visible;}
  function feedback(message,success=false,target="app-feedback"){
    const el=$(target);el.textContent=message;
    el.classList.toggle("success",success);
  }
  function formatDate(value, options){
    return new Intl.DateTimeFormat("en-AU",{timeZone:TZ,...options}).format(new Date(value));
  }
  const dayLabel = (v) => formatDate(v,{weekday:"long",day:"numeric",month:"long",year:"numeric"});
  const timeLabel = (v) => formatDate(v,{hour:"numeric",minute:"2-digit",hour12:true});
  function todaySydney(){
    const parts = new Intl.DateTimeFormat("en-GB",{
      timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"
    }).formatToParts(new Date());
    const find=(name)=>parts.find(p=>p.type===name)?.value;
    return find("year")+"-"+find("month")+"-"+find("day");
  }
  // Convert a Sydney wall-clock time to UTC, even if the coach's device is elsewhere.
  function fromSydneyWallClock(dateStr,timeStr){
    const [y,m,d]=dateStr.split("-").map(Number);
    const [h,min]=timeStr.split(":").map(Number);
    const target=Date.UTC(y,m-1,d,h,min);
    let guess=target;
    for(let i=0;i<4;i++){
      const parts=new Intl.DateTimeFormat("en-GB",{
        timeZone:TZ,hour12:false,hourCycle:"h23",
        year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"
      }).formatToParts(new Date(guess));
      const val=(key)=>Number(parts.find(p=>p.type===key)?.value);
      const calculated=Date.UTC(val("year"),val("month")-1,val("day"),val("hour")%24,val("minute"));
      guess+=target-calculated;
    }
    const checked=formatDate(guess,{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
    if(!Number.isFinite(guess)||!checked)throw Error("Invalid Sydney date/time.");
    return new Date(guess);
  }
  function addWeeks(day,weeks){
    const [y,m,d]=day.split("-").map(Number);
    const dt=new Date(Date.UTC(y,m-1,d+7*weeks));
    return dt.toISOString().slice(0,10);
  }
  function showAuth(){
    setVisible("setup-panel",false);
    setVisible("auth-panel",true);
    setVisible("app-panel",false);
  }
  function showApp(){
    setVisible("setup-panel",false);
    setVisible("auth-panel",false);
    setVisible("app-panel",true);
  }
  function chooseAuthTab(tab){
    ["login","signup","reset"].forEach((id)=>setVisible(id+"-form",id===tab));
    $("login-tab").classList.toggle("active",tab==="login");
    $("signup-tab").classList.toggle("active",tab==="signup");
    $("login-tab").setAttribute("aria-selected",String(tab==="login"));
    $("signup-tab").setAttribute("aria-selected",String(tab==="signup"));
    feedback("",false,"auth-feedback");
  }
  function chooseView(view){
    document.querySelectorAll(".app-tab").forEach(button=>{
      const selected=button.dataset.view===view;
      button.classList.toggle("selected",selected);
      button.setAttribute("aria-selected",String(selected));
    });
    ["availability","bookings","profile","admin"].forEach(key=>setVisible("view-"+key,key===view));
    feedback("");
    if(view==="availability")void loadSlots();
    if(view==="bookings")void loadMyBookings();
    if(view==="admin"&&state.profile?.role==="admin")void loadAdmin();
  }
  async function loadProfile(){
    const {data,error}=await state.db.from("hg_profiles")
      .select("id,display_name,email,phone,role").eq("id",state.user.id).single();
    if(error)throw Error("Could not load your client account: "+error.message);
    state.profile=data;
    const name=data.display_name?.trim()||"LET'S GET TO WORK.";
    $("welcome-name").textContent="HEY, "+name.toUpperCase()+".";
    $("profile-name").value=data.display_name||"";
    $("profile-email").value=data.email||state.user.email||"";
    $("profile-phone").value=data.phone||"";
    $("admin-tab").hidden=data.role!=="admin";
  }
  async function loadSettings(){
    const {data,error}=await state.db.from("hg_settings")
      .select("cancellation_cutoff_hours,max_open_bookings,bookable_days_ahead")
      .eq("id",1).single();
    if(error)throw Error("Could not load booking rules: "+error.message);
    state.settings=data;
    $("cancellation-policy").textContent=
      "Need to cancel? You can do it here up to "+
      data.cancellation_cutoff_hours+" hours before the session. For late changes, contact HARD GYM.";
    if(state.profile?.role==="admin"){
      $("setting-cutoff").value=data.cancellation_cutoff_hours;
      $("setting-max").value=data.max_open_bookings;
      $("setting-window").value=data.bookable_days_ahead;
    }
  }
  async function refreshUser(){
    if(!state.db)return;
    const {data:{user},error}=await state.db.auth.getUser();
    if(error && !user){showAuth();feedback(error.message,false,"auth-feedback");return;}
    if(!user){state.user=null;state.profile=null;showAuth();return;}
    state.user=user;
    try{
      await loadProfile();
      await loadSettings();
      if(state.recovery){showAuth();chooseAuthTab("reset");return;}
      showApp();
      chooseView("availability");
    }catch(e){showAuth();feedback(e.message||String(e),false,"auth-feedback");}
  }

  async function loadSlots(){
    if(!state.db||!state.user)return;
    const host=$("slots-list");host.innerHTML='<p class="empty">CHECKING AVAILABLE TIMES…</p>';
    const {data,error}=await state.db.rpc("hg_available_slots");
    if(error){host.innerHTML='<p class="empty">'+safe(error.message)+'</p>';return;}
    state.slots=data||[];
    renderSlots();
  }
  function renderSlots(){
    const service=$("service-filter").value;
    const slots=state.slots.filter(s=>service==="all"||s.service===service);
    if(!slots.length){
      $("slots-list").innerHTML='<p class="empty">NO AVAILABLE TIMES ARE LISTED YET. CHECK BACK SOON OR CONTACT HARD GYM.</p>';
      return;
    }
    const groups=new Map();
    for(const slot of slots){
      const date=dayLabel(slot.starts_at);
      if(!groups.has(date))groups.set(date,[]);
      groups.get(date).push(slot);
    }
    $("slots-list").innerHTML=[...groups].map(([day,daySlots])=>
      '<section class="date-group"><h3>'+safe(day.toUpperCase())+'</h3>'+
      daySlots.map(slot=>{
        const remaining=Number(slot.spots_left);
        const full=remaining<=0;
        const label=serviceNames[slot.service]||slot.service;
        const spotLabel=full?"FULLY BOOKED":slot.service==="small_group"?
          remaining+" "+(remaining===1?"PLACE":"PLACES")+" LEFT":"SESSION AVAILABLE";
        return '<article class="slot-card"><div><h4>'+safe(timeLabel(slot.starts_at))+
          ' – '+safe(timeLabel(slot.ends_at))+'</h4>'+
          '<p>'+safe(label)+' · '+safe(slot.coach)+'</p>'+
          '<span class="pill '+(full?"full":"")+'">'+safe(spotLabel)+'</span>'+
          '</div><button type="button" class="button button-light" data-book="'+
          Number(slot.slot_id)+'" '+(full?"disabled":"")+'>BOOK THIS TIME</button></article>';
      }).join("")+'</section>'
    ).join("");
  }
  function openBooking(slot){
    state.bookingSlot=slot;
    $("dialog-details").textContent=(serviceNames[slot.service]||slot.service)+
      " · "+dayLabel(slot.starts_at)+", "+timeLabel(slot.starts_at)+" (Sydney time)";
    setVisible("partner-field",slot.service==="partner");
    $("booking-partner-name").value="";
    $("booking-dialog").showModal();
  }
  async function loadMyBookings(){
    const host=$("my-bookings-list");
    host.innerHTML='<p class="empty">LOADING YOUR BOOKINGS…</p>';
    const {data,error}=await state.db.from("hg_bookings")
      .select("id,status,created_at,partner_name,hg_slots(starts_at,ends_at,service,coach)")
      .eq("user_id",state.user.id).order("created_at",{ascending:false}).limit(100);
    if(error){host.innerHTML='<p class="empty">'+safe(error.message)+'</p>';return;}
    state.myBookings=(data||[]).sort((a,b)=>
      new Date(a.hg_slots?.starts_at||0)-new Date(b.hg_slots?.starts_at||0));
    const upcoming=state.myBookings.filter(b=>b.status==="confirmed"&&
      new Date(b.hg_slots?.starts_at)>new Date());
    const other=state.myBookings.filter(b=>!upcoming.includes(b)).slice(-12).reverse();
    if(!state.myBookings.length){
      host.innerHTML='<p class="empty">NOTHING BOOKED YET. HEAD TO AVAILABLE SESSIONS TO LOCK IN YOUR NEXT TIME.</p>';return;
    }
    const card=(b)=>{
      const slot=b.hg_slots||{};
      const cutoff=state.settings?.cancellation_cutoff_hours??12;
      const canCancel=b.status==="confirmed"&&new Date(slot.starts_at).getTime()-Date.now()>=cutoff*3600000;
      return '<article class="booking-card"><div><h4>'+safe(dayLabel(slot.starts_at))+
        ' · '+safe(timeLabel(slot.starts_at))+'</h4><p>'+safe(serviceNames[slot.service]||slot.service)+
        ' · '+safe(slot.coach||"HARD GYM")+'</p>'+
        (b.partner_name?'<p>Partner: '+safe(b.partner_name)+'</p>':"")+
        '<span class="pill '+(b.status!=="confirmed"?"full":"")+'">'+
        (b.status==="confirmed"?"CONFIRMED":"CANCELLED")+'</span></div>'+
        (canCancel?'<button type="button" class="button button-outline" data-cancel="'+safe(b.id)+'">CANCEL BOOKING</button>':'')+
        '</article>';
    };
    host.innerHTML=(upcoming.length?'<h3>UPCOMING SESSIONS</h3>'+upcoming.map(card).join(""):"")+
      (other.length?'<h3>PAST & CANCELLED</h3>'+other.map(card).join(""):"");
  }
  async function loadAdmin(){
    if(state.profile?.role!=="admin")return;
    $("admin-date").min=todaySydney();
    if(!$("admin-date").value)$("admin-date").value=todaySydney();
    const [{data:slots,error:se},{data:bookings,error:be}]=await Promise.all([
      state.db.from("hg_slots").select("*")
        .gte("starts_at",new Date(Date.now()-86400000).toISOString())
        .order("starts_at",{ascending:true}).limit(250),
      state.db.from("hg_bookings")
        .select("id,status,created_at,partner_name,hg_profiles(display_name,email,phone),hg_slots(starts_at,ends_at,service,coach)")
        .order("created_at",{ascending:false}).limit(150)
    ]);
    if(se||be){feedback((se||be).message);return;}
    state.adminSlots=slots||[];
    state.adminBookings=bookings||[];
    renderAdmin();
  }
  function renderAdmin(){
    $("admin-slots-list").innerHTML=state.adminSlots.length?state.adminSlots.map(slot=>{
      const count=state.adminBookings.filter(b=>b.status==="confirmed"&&
        b.hg_slots?.starts_at===slot.starts_at&&
        b.hg_slots?.coach===slot.coach).length;
      return '<div class="admin-item"><div><strong>'+safe(dayLabel(slot.starts_at))+
        ' · '+safe(timeLabel(slot.starts_at))+'</strong><small>'+
        safe(serviceNames[slot.service]||slot.service)+' · '+safe(slot.coach)+
        ' · '+count+'/'+slot.capacity+' booked · '+(slot.is_active?"OPEN":"BLOCKED")+
        '</small></div>'+(slot.is_active?'<button type="button" data-block="'+slot.id+'">BLOCK</button>':'')+'</div>';
    }).join(""):'<p class="empty">NO SESSIONS CREATED YET.</p>';
    const upcoming=state.adminBookings.filter(b=>b.status==="confirmed"&&
      new Date(b.hg_slots?.starts_at)>new Date()).sort((a,b)=>
      new Date(a.hg_slots?.starts_at)-new Date(b.hg_slots?.starts_at));
    $("admin-bookings-list").innerHTML=upcoming.length?upcoming.map(b=>{
      const p=b.hg_profiles||{},slot=b.hg_slots||{};
      return '<div class="admin-item"><div><strong>'+safe(p.display_name||"Client")+
        ' · '+safe(dayLabel(slot.starts_at))+' '+safe(timeLabel(slot.starts_at))+'</strong><small>'+
        safe(serviceNames[slot.service]||slot.service)+' · '+safe(p.email||"")+
        (p.phone?' · '+safe(p.phone):'')+(b.partner_name?' · Partner: '+safe(b.partner_name):'')+
        '</small></div><button type="button" data-admin-cancel="'+safe(b.id)+'">CANCEL</button></div>';
    }).join(""):'<p class="empty">NO UPCOMING CLIENT BOOKINGS.</p>';
  }
  function bindEvents(){
    $("login-tab").addEventListener("click",()=>chooseAuthTab("login"));
    $("signup-tab").addEventListener("click",()=>chooseAuthTab("signup"));
    $("login-form").addEventListener("submit",async (e)=>{
      e.preventDefault();feedback("SIGNING IN…",false,"auth-feedback");
      const {error}=await state.db.auth.signInWithPassword({
        email:$("login-email").value.trim(),password:$("login-password").value
      });
      if(error){feedback(error.message,false,"auth-feedback");return;}
      await refreshUser();
    });
    $("signup-form").addEventListener("submit",async (e)=>{
      e.preventDefault();feedback("CREATING ACCOUNT…",false,"auth-feedback");
      if(!$("signup-consent").checked){feedback("Please read and accept the privacy information.",false,"auth-feedback");return;}
      const {error}=await state.db.auth.signUp({
        email:$("signup-email").value.trim(),password:$("signup-password").value,
        options:{
          data:{full_name:$("signup-name").value.trim()},
          emailRedirectTo:location.origin+location.pathname
        }
      });
      if(error){feedback(error.message,false,"auth-feedback");return;}
      feedback("Check your email to verify your account, then sign in.",true,"auth-feedback");
    });
    $("forgot-password").addEventListener("click",async()=>{
      const email=$("login-email").value.trim()||
        window.prompt("Enter the email for your HARD GYM account:","");
      if(!email)return;
      const {error}=await state.db.auth.resetPasswordForEmail(email,{
        redirectTo:location.origin+location.pathname
      });
      feedback(error?error.message:"If this account exists, you'll receive a password reset email.",!error,"auth-feedback");
    });
    $("reset-form").addEventListener("submit",async(e)=>{
      e.preventDefault();
      const {error}=await state.db.auth.updateUser({password:$("reset-password").value});
      if(error){feedback(error.message,false,"auth-feedback");return;}
      state.recovery=false;
      await refreshUser();
      feedback("Password updated.",true);
    });
    $("logout-button").addEventListener("click",async()=>{
      const {error}=await state.db.auth.signOut();
      if(error){feedback(error.message);return;}
      state.user=null;state.profile=null;showAuth();chooseAuthTab("login");
    });
    document.querySelectorAll(".app-tab").forEach(b=>b.addEventListener("click",()=>{
      if(b.dataset.view==="admin"&&state.profile?.role!=="admin")return;
      chooseView(b.dataset.view);
    }));
    $("service-filter").addEventListener("change",renderSlots);
    $("refresh-slots").addEventListener("click",loadSlots);
    $("slots-list").addEventListener("click",e=>{
      const button=e.target.closest("[data-book]");if(!button)return;
      const slot=state.slots.find(s=>Number(s.slot_id)===Number(button.dataset.book));
      if(slot && Number(slot.spots_left)>0)openBooking(slot);
    });
    $("cancel-dialog").addEventListener("click",()=>$("booking-dialog").close());
    $("confirm-booking-form").addEventListener("submit",async(e)=>{
      e.preventDefault();
      const slot=state.bookingSlot;if(!slot)return;
      const button=e.target.querySelector('button[type="submit"]');
      button.disabled=true;button.textContent="BOOKING…";
      try{
        const {error}=await state.db.rpc("hg_book_slot",{
          p_slot_id:Number(slot.slot_id),
          p_partner_name:slot.service==="partner"?$("booking-partner-name").value.trim():null
        });
        if(error)throw error;
        $("booking-dialog").close();
        feedback("BOOKING CONFIRMED. Your session is listed under MY BOOKINGS.",true);
        await loadSlots();
      }catch(e){feedback(e.message||String(e));$("booking-dialog").close();await loadSlots();}
      finally{button.disabled=false;button.textContent="CONFIRM BOOKING";}
    });
    $("my-bookings-list").addEventListener("click",async(e)=>{
      const btn=e.target.closest("[data-cancel]");if(!btn)return;
      if(!window.confirm("Cancel this HARD GYM booking?"))return;
      btn.disabled=true;
      const {error}=await state.db.rpc("hg_cancel_booking",{p_booking_id:btn.dataset.cancel});
      feedback(error?error.message:"Booking cancelled.",!error);
      await Promise.all([loadMyBookings(),loadSlots()]);
    });
    $("profile-form").addEventListener("submit",async(e)=>{
      e.preventDefault();
      const name=$("profile-name").value.trim();
      if(!name){feedback("Please enter your name.");return;}
      const {error}=await state.db.from("hg_profiles").update({
        display_name:name,phone:$("profile-phone").value.trim()
      }).eq("id",state.user.id);
      if(error){feedback(error.message);return;}
      await loadProfile();feedback("Details updated.",true);
    });
    $("admin-service").addEventListener("change",()=>{
      $("admin-capacity").value=$("admin-service").value==="small_group"?"8":"1";
      $("admin-capacity").readOnly=$("admin-service").value!=="small_group";
    });
    $("create-slot-form").addEventListener("submit",async(e)=>{
      e.preventDefault();if(state.profile?.role!=="admin")return;
      const date=$("admin-date").value,time=$("admin-time").value;
      const duration=Number($("admin-duration").value);
      const service=$("admin-service").value,coach=$("admin-coach").value.trim();
      const capacity=service==="small_group"?Number($("admin-capacity").value):1;
      const total=$("admin-repeat").checked?4:1;
      let created=0;const errors=[];
      for(let i=0;i<total;i++){
        try{
          const starts=fromSydneyWallClock(addWeeks(date,i),time);
          const ends=new Date(starts.getTime()+duration*60000);
          if(starts<=new Date())throw Error("The time is in the past.");
          const {error}=await state.db.from("hg_slots").insert({
            service,coach,capacity,starts_at:starts.toISOString(),ends_at:ends.toISOString()
          });
          if(error)throw error;
          created++;
        }catch(error){errors.push("Week "+(i+1)+": "+(error.message||String(error)));}
      }
      feedback("Added "+created+"/"+total+" time slots."+
        (errors.length?" "+errors.join(" | "):""),errors.length===0);
      await Promise.all([loadAdmin(),loadSlots()]);
    });
    $("admin-slots-list").addEventListener("click",async(e)=>{
      const button=e.target.closest("[data-block]");if(!button)return;
      if(!window.confirm("Block this time? Any existing client bookings must be cancelled first."))return;
      const {error}=await state.db.from("hg_slots")
        .update({is_active:false}).eq("id",Number(button.dataset.block));
      feedback(error?error.message:"Time blocked.",!error);
      await Promise.all([loadAdmin(),loadSlots()]);
    });
    $("admin-bookings-list").addEventListener("click",async(e)=>{
      const button=e.target.closest("[data-admin-cancel]");if(!button)return;
      if(!window.confirm("Cancel this client's booking? They will be notified by email if notifications are configured."))return;
      const {error}=await state.db.rpc("hg_cancel_booking",{p_booking_id:button.dataset.adminCancel});
      feedback(error?error.message:"Client booking cancelled.",!error);
      await Promise.all([loadAdmin(),loadSlots()]);
    });
    $("settings-form").addEventListener("submit",async(e)=>{
      e.preventDefault();if(state.profile?.role!=="admin")return;
      const {error}=await state.db.from("hg_settings").update({
        cancellation_cutoff_hours:Number($("setting-cutoff").value),
        max_open_bookings:Number($("setting-max").value),
        bookable_days_ahead:Number($("setting-window").value)
      }).eq("id",1);
      feedback(error?error.message:"Booking rules saved.",!error);
      if(!error)await loadSettings();
    });
    document.addEventListener("visibilitychange",()=>{
      if(document.visibilityState==="visible" && state.user && !$("app-panel").hidden)void loadSlots();
    });
  }

  if(!/^https:\/\/[^/]+\.supabase\.co$/.test(config.supabaseUrl||"") ||
    !(config.supabaseAnonKey||"").trim()){
    setVisible("setup-panel",true);
    return;
  }
  try{
    const {createClient}=await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    state.db=createClient(config.supabaseUrl,config.supabaseAnonKey,{
      auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:true}
    });
    bindEvents();
    state.db.auth.onAuthStateChange((event)=>{
      if(event==="PASSWORD_RECOVERY"){
        state.recovery=true;
        showAuth();chooseAuthTab("reset");
      }else if(event==="SIGNED_OUT"){
        state.user=null;state.profile=null;showAuth();
      }
      // Do not await database requests inside onAuthStateChange.
    });
    await refreshUser();
  }catch(error){
    setVisible("setup-panel",true);
    setVisible("auth-panel",false);
    setVisible("app-panel",false);
    $("setup-panel").querySelector("p:not(.eyebrow)").textContent=
      "The booking system is temporarily unavailable. Please contact HARD GYM to arrange a session.";
    console.error("HARD GYM booking initialization failed:",error?.message||String(error));
  }
})();
