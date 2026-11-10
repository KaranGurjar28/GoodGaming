const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'development-only-change-this-secret';
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const nowISO = () => new Date().toISOString();
const uid = prefix => `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

function initialData() {
  return {
    settings: {
      businessName: 'Good Gaming', tagline: 'Play. Connect. Conquer.',
      phone: '', address: '', instagram: '', openingTime: '10:00', closingTime: '23:00',
      slotMinutes: 60, currency: 'INR', bookingNoticeHours: 1,
      bookingPolicy: 'Please arrive 10 minutes before your session. Late arrivals may reduce play time.',
      menuIntro: 'Fuel your game. Order your favourites right from your gaming station.'
    },
    resources: [
      {id:'pc',name:'Gaming PC',category:'PC Gaming',quantity:4,price:120,active:true,description:'High-performance gaming stations.'},
      {id:'ps5',name:'PlayStation 5',category:'Console Gaming',quantity:3,price:180,active:true,description:'Next-gen console gaming.'},
      {id:'sim',name:'MOZA Racing Simulator',category:'Racing',quantity:1,price:250,active:true,description:'Triple-screen racing simulator experience.'},
      {id:'pool',name:'Pool Table',category:'Pool',quantity:1,price:150,active:true,description:'Challenge your friends.'},
      {id:'watch',name:'Watch Party',category:'Events',quantity:1,price:0,active:true,description:'Watch matches and events together.'}
    ],
    bookings: [], orders: [],
    menu: [
      {id:uid('MENU'),name:'Classic Burger',category:'Burgers',description:'Placeholder menu item – customise this in Admin.',price:149,active:true},
      {id:uid('MENU'),name:'Loaded Fries',category:'Snacks',description:'Placeholder menu item – customise this in Admin.',price:99,active:true},
      {id:uid('MENU'),name:'Cold Coffee',category:'Beverages',description:'Placeholder menu item – customise this in Admin.',price:119,active:true},
      {id:uid('MENU'),name:'Margherita Pizza',category:'Pizza',description:'Placeholder menu item – customise this in Admin.',price:199,active:true},
      {id:uid('MENU'),name:'Good Gaming Combo',category:'Combos',description:'Placeholder combo – customise this in Admin.',price:249,active:true}
    ],
    blocked: [],
    coupons: [],
    users: [],
    admin: null
  };
}
function readDB() {
  if (!fs.existsSync(DATA_FILE)) {
    const d = initialData();
    const email = process.env.ADMIN_EMAIL || 'admin@goodgaming.in';
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
    d.admin = { email, passwordHash: bcrypt.hashSync(password, 10), name: 'Good Gaming Admin' };
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
    return d;
  }
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const base = initialData();
  for (const k of Object.keys(base)) if (d[k] === undefined) d[k] = base[k];
  return d;
}
let db = readDB();
function save() { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }

function auth(req,res,next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  try {
    if (!token) throw new Error('Missing token');
    req.admin = jwt.verify(token, SECRET);
    next();
  } catch { res.status(401).json({error:'Please sign in as an administrator.'}); }
}
const clean = value => String(value ?? '').trim();
const dateValid = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime());
const timeMins = t => { const [h,m] = String(t).split(':').map(Number); return h*60+m; };
const overlaps = (a,b,c,d) => a < d && c < b;

function availability(resourceId, date, duration, ignoreId) {
  const r = db.resources.find(x=>x.id===resourceId && x.active);
  if (!r) return [];
  const step = Number(db.settings.slotMinutes) || 60;
  const open = timeMins(db.settings.openingTime), close = timeMins(db.settings.closingTime);
  const slots = [];
  for (let start=open; start+duration<=close; start+=step) {
    const end=start+duration;
    const active = db.bookings.filter(b=>b.resourceId===resourceId && b.date===date && b.status!=='Cancelled' && b.id!==ignoreId && overlaps(start,end,timeMins(b.startTime),timeMins(b.endTime)));
    const blocked = db.blocked.some(b=>b.resourceId===resourceId && b.date===date && overlaps(start,end,timeMins(b.startTime),timeMins(b.endTime)));
    const used = active.reduce((n,b)=>n+Number(b.quantity||1),0);
    slots.push({startTime:`${String(Math.floor(start/60)).padStart(2,'0')}:${String(start%60).padStart(2,'0')}`,endTime:`${String(Math.floor(end/60)).padStart(2,'0')}:${String(end%60).padStart(2,'0')}`,available:!blocked && used<r.quantity,remaining:blocked?0:Math.max(0,r.quantity-used)});
  }
  return slots;
}

app.get('/api/public', (req,res) => res.json({settings:db.settings,resources:db.resources.filter(r=>r.active),menu:db.menu.filter(m=>m.active)}));
app.get('/api/availability', (req,res) => {
  const {resourceId,date,duration='60'}=req.query;
  if (!dateValid(date)) return res.status(400).json({error:'Choose a valid date.'});
  const minutes=Math.max(30,Math.min(360,Number(duration)||60));
  res.json({slots:availability(resourceId,date,minutes)});
});
app.post('/api/bookings', (req,res) => {
  const b=req.body||{};
  const resource=db.resources.find(r=>r.id===clean(b.resourceId)&&r.active);
  if(!resource) return res.status(400).json({error:'This facility is unavailable.'});
  if(!dateValid(b.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.startTime||'')) return res.status(400).json({error:'Select a valid date and time.'});
  const duration=Math.max(30,Math.min(360,Number(b.duration)||60));
  const start=timeMins(b.startTime), end=start+duration;
  const endTime=`${String(Math.floor(end/60)).padStart(2,'0')}:${String(end%60).padStart(2,'0')}`;
  const available=availability(resource.id,b.date,duration).find(s=>s.startTime===b.startTime);
  const quantity=Math.max(1,Math.min(resource.quantity,Number(b.quantity)||1));
  if(!available || !available.available || available.remaining<quantity) return res.status(409).json({error:'Sorry, this slot is no longer available. Please choose another.'});
  if(end>timeMins(db.settings.closingTime)) return res.status(400).json({error:'This session ends after closing time.'});
  const name=clean(b.customerName), phone=clean(b.phone);
  if(name.length<2||phone.length<8) return res.status(400).json({error:'Enter your name and a valid phone number.'});
  const booking={id:uid('GG'),resourceId:resource.id,resourceName:resource.name,date:b.date,startTime:b.startTime,endTime,duration,quantity,customerName:name,phone,email:clean(b.email),notes:clean(b.notes),price:resource.price*duration/60*quantity,status:'Confirmed',source:'Website',createdAt:nowISO()};
  db.bookings.push(booking); save(); res.status(201).json({booking});
});
app.post('/api/orders', (req,res) => {
  const b=req.body||{}, items=Array.isArray(b.items)?b.items:[];
  if(!clean(b.customerName)||items.length===0) return res.status(400).json({error:'Add items and your name to place an order.'});
  let total=0, lines=[];
  for(const line of items){
    const item=db.menu.find(m=>m.id===line.id&&m.active);
    const qty=Math.max(1,Math.min(50,Number(line.quantity)||1));
    if(item){total+=item.price*qty;lines.push({id:item.id,name:item.name,price:item.price,quantity:qty});}
  }
  if(!lines.length) return res.status(400).json({error:'No available menu items in this order.'});
  const order={id:uid('ORD'),customerName:clean(b.customerName),phone:clean(b.phone),station:clean(b.station)||'Counter / Not specified',notes:clean(b.notes),items:lines,total,status:'Received',createdAt:nowISO()};
  db.orders.push(order);save();res.status(201).json({order});
});

app.post('/api/admin/login',(req,res)=>{
  const email=clean(req.body.email).toLowerCase(), password=String(req.body.password||'');
  if(email!==String(db.admin.email).toLowerCase()||!bcrypt.compareSync(password,db.admin.passwordHash)) return res.status(401).json({error:'Incorrect email or password.'});
  const token=jwt.sign({email,name:db.admin.name},SECRET,{expiresIn:'12h'});
  res.json({token,name:db.admin.name,email});
});
app.get('/api/admin/overview',auth,(req,res)=>{
  const today=new Date().toISOString().slice(0,10);
  const todayBookings=db.bookings.filter(b=>b.date===today);
  const todayOrders=db.orders.filter(o=>o.createdAt.slice(0,10)===today);
  const revenue=[...db.bookings.filter(b=>b.status!=='Cancelled'),...db.orders.filter(o=>o.status!=='Cancelled')].reduce((s,x)=>s+Number(x.price??x.total??0),0);
  res.json({bookings:db.bookings,orders:db.orders,resources:db.resources,menu:db.menu,blocked:db.blocked,settings:db.settings,coupons:db.coupons,stats:{todayBookings:todayBookings.length,todayOrders:todayOrders.length,revenue,totalBookings:db.bookings.length,activeSessions:db.bookings.filter(b=>b.status==='Confirmed'&&b.date===today).length}});
});
app.patch('/api/admin/bookings/:id',auth,(req,res)=>{
  const b=db.bookings.find(x=>x.id===req.params.id); if(!b)return res.status(404).json({error:'Booking not found.'});
  if(req.body.status)b.status=req.body.status;
  if(req.body.notes!==undefined)b.notes=clean(req.body.notes);
  save();res.json({booking:b});
});
app.patch('/api/admin/orders/:id',auth,(req,res)=>{
  const o=db.orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'Order not found.'});
  if(req.body.status)o.status=req.body.status;save();res.json({order:o});
});
app.post('/api/admin/resources',auth,(req,res)=>{
  const b=req.body||{}, id=clean(b.id)||uid('RES');
  const item={id,name:clean(b.name),category:clean(b.category)||'Gaming',quantity:Math.max(1,Number(b.quantity)||1),price:Math.max(0,Number(b.price)||0),active:b.active!==false,description:clean(b.description)};
  if(!item.name)return res.status(400).json({error:'Resource name is required.'});
  const i=db.resources.findIndex(x=>x.id===id);if(i>=0)db.resources[i]=item;else db.resources.push(item);save();res.json({resource:item});
});
app.delete('/api/admin/resources/:id',auth,(req,res)=>{const r=db.resources.find(x=>x.id===req.params.id);if(!r)return res.status(404).json({error:'Not found.'});r.active=false;save();res.json({ok:true});});
app.post('/api/admin/menu',auth,(req,res)=>{
  const b=req.body||{},id=clean(b.id)||uid('MENU');
  const item={id,name:clean(b.name),category:clean(b.category)||'Other',description:clean(b.description),price:Math.max(0,Number(b.price)||0),active:b.active!==false};
  if(!item.name)return res.status(400).json({error:'Menu item name is required.'});
  const i=db.menu.findIndex(x=>x.id===id);if(i>=0)db.menu[i]=item;else db.menu.push(item);save();res.json({item});
});
app.delete('/api/admin/menu/:id',auth,(req,res)=>{const m=db.menu.find(x=>x.id===req.params.id);if(!m)return res.status(404).json({error:'Not found.'});m.active=false;save();res.json({ok:true});});
app.post('/api/admin/blocked',auth,(req,res)=>{
  const b=req.body||{};if(!dateValid(b.date)||!b.resourceId||!b.startTime||!b.endTime)return res.status(400).json({error:'Complete all block details.'});
  const item={id:uid('BLK'),resourceId:clean(b.resourceId),date:b.date,startTime:b.startTime,endTime:b.endTime,reason:clean(b.reason)||'Maintenance'};
  db.blocked.push(item);save();res.json({block:item});
});
app.delete('/api/admin/blocked/:id',auth,(req,res)=>{db.blocked=db.blocked.filter(x=>x.id!==req.params.id);save();res.json({ok:true});});
app.put('/api/admin/settings',auth,(req,res)=>{
  const allowed=['businessName','tagline','phone','address','instagram','openingTime','closingTime','slotMinutes','bookingNoticeHours','bookingPolicy','menuIntro'];
  for(const k of allowed)if(req.body[k]!==undefined)db.settings[k]=req.body[k];
  save();res.json({settings:db.settings});
});
app.put('/api/admin/password',auth,(req,res)=>{
  const old=String(req.body.oldPassword||''), next=String(req.body.newPassword||'');
  if(!bcrypt.compareSync(old,db.admin.passwordHash))return res.status(400).json({error:'Current password is incorrect.'});
  if(next.length<10)return res.status(400).json({error:'Use at least 10 characters for the new password.'});
  db.admin.passwordHash=bcrypt.hashSync(next,10);save();res.json({ok:true});
});
app.get('/api/menu-qr',async(req,res)=>{
  const base=process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`;
  const station=clean(req.query.station);
  const url=`${base}/?view=menu${station?'&station='+encodeURIComponent(station):''}`;
  try{const data=await QRCode.toDataURL(url,{width:600,margin:2,color:{dark:'#171717',light:'#ffffff'}});res.json({url,data});}catch{res.status(500).json({error:'Could not generate QR.'});}
});
app.get('/api/health',(req,res)=>res.json({ok:true,app:'Good Gaming'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`Good Gaming is running at http://localhost:${PORT}`));
