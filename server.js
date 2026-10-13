const express=require('express');
const http=require('http');
const path=require('path');
const fs=require('fs');
const crypto=require('crypto');
const {Server}=require('socket.io');
const {OAuth2Client}=require('google-auth-library');
const APP_VERSION='4.2.1'; // friend circle, DMs and per-friend streaks
const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:true,credentials:true},maxHttpBufferSize:3e6});
app.use(express.json({limit:'4mb'}));
app.use(express.static(path.join(__dirname,'public')));
const DATA_FILE=path.join(__dirname,'gamenight-data.json');
let data={accounts:{},accountSessions:{},connections:{},rooms:{}};
try{data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))}catch{}
data.accounts ||= {}; data.accountSessions ||= {}; data.connections ||= {}; data.rooms ||= {}; data.friendships ||= {}; data.friendRequests ||= []; data.directMessages ||= {}; data.socialProfiles ||= {}; data.presence ||= {}; data.streaks ||= {};
function saveData(){try{fs.writeFileSync(DATA_FILE,JSON.stringify(data,null,2))}catch{}}
function clean(v,n=160){return String(v??'').replace(/[<>]/g,'').trim().slice(0,n)}
function token(){return crypto.randomBytes(24).toString('hex')}
const ADMIN_EMAIL=String(process.env.GAME_NIGHT_ADMIN_EMAIL||'').trim().toLowerCase();
const FREE_EMAILS=new Set(String(process.env.GAME_NIGHT_FREE_EMAILS||'').split(/[;,]/).map(x=>x.trim().toLowerCase()).filter(Boolean));
if(ADMIN_EMAIL)FREE_EMAILS.add(ADMIN_EMAIL);
function accessFor(account){const email=String(account?.email||'').trim().toLowerCase();const admin=Boolean(email&&ADMIN_EMAIL&&email===ADMIN_EMAIL);const friend=Boolean(email&&FREE_EMAILS.has(email));return {role:admin?'admin':'member',plan:friend?'complimentary':'free',premiumAccess:friend,reason:admin?'creator account':friend?'creator-approved friend':'standard account'};}
function accountPayload(account){return {id:account.id,name:account.name,email:account.email||'',picture:account.picture||'',session:account.session,authenticated:true,provider:account.provider||'google',access:accessFor(account)}}
function dayKey(){return new Date().toISOString().slice(0,10)}
const GOOGLE_CLIENT_ID=process.env.GOOGLE_CLIENT_ID||'';
const googleClient=GOOGLE_CLIENT_ID?new OAuth2Client(GOOGLE_CLIENT_ID):null;
app.get('/api/config',(req,res)=>res.json({version:APP_VERSION,googleClientId:GOOGLE_CLIENT_ID,pwa:true}));
function authenticatedAccount(req,res){const session=clean(req.body?.session,100);const id=data.accountSessions[session];const account=Object.values(data.accounts).find(a=>a.id===id&&a.session===session);if(!account){res.status(401).json({error:'Please sign in again.'});return null}return account}
function pairKey(a,b){return [String(a),String(b)].sort().join(':')}
function socialProfile(account){const custom=data.socialProfiles[account.id]||{};return {id:account.id,name:custom.name||account.name||'Player',bio:custom.bio||'',avatar:custom.avatar||account.picture||'🌙',picture:custom.picture||account.picture||'',wallpaper:custom.wallpaper||'lofi-night',createdAt:account.createdAt||0}}
function pairStreak(a,b){const raw=data.streaks[pairKey(a,b)]||{current:0,best:0,lastActiveDay:null};const today=dayKey();const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);return {...raw,current:raw.lastActiveDay===today||raw.lastActiveDay===yesterday?raw.current||0:0}}
function markPairStreak(a,b){if(!a||!b||a===b)return;const key=pairKey(a,b);if(!data.friendships[key])return;const today=dayKey();const st=data.streaks[key]||{current:0,best:0,lastActiveDay:null};if(st.lastActiveDay===today)return;const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);st.current=st.lastActiveDay===yesterday?(st.current||0)+1:1;st.best=Math.max(st.best||0,st.current);st.lastActiveDay=today;st.updatedAt=Date.now();data.streaks[key]=st;saveData()}
function accountById(id){return Object.values(data.accounts).find(a=>a.id===id)||null}
function socialCard(id){const account=accountById(id);if(!account)return null;const lastSeen=data.presence[id]||0;const custom=socialProfile(account);return {...custom,online:Date.now()-lastSeen<90000,lastSeen:lastSeen||null}}
app.post('/api/social/state',(req,res)=>{const me=authenticatedAccount(req,res);if(!me)return;data.presence[me.id]=Date.now();const friends=Object.values(data.friendships).filter(f=>f.users?.includes(me.id)).map(f=>{const otherId=f.users.find(id=>id!==me.id);const person=socialCard(otherId);if(!person)return null;const key=pairKey(me.id,otherId);const msgs=data.directMessages[key]||[];return {...person,connectedAt:f.createdAt||0,streak:pairStreak(me.id,otherId),unreadCount:msgs.filter(m=>m.to===me.id&&!m.readAt).length,lastMessage:msgs[msgs.length-1]||null}}).filter(Boolean).sort((a,b)=>(b.lastMessage?.time||0)-(a.lastMessage?.time||0));const incoming=data.friendRequests.filter(r=>r.to===me.id&&r.status==='pending').map(r=>({...r,person:socialCard(r.from)})).filter(r=>r.person);const outgoing=data.friendRequests.filter(r=>r.from===me.id&&r.status==='pending').map(r=>({...r,person:socialCard(r.to)})).filter(r=>r.person);const friendIds=new Set(friends.map(f=>f.id));const pendingIds=new Set([...incoming.map(r=>r.from),...outgoing.map(r=>r.to)]);const discover=Object.values(data.accounts).filter(a=>a.id!==me.id&&!friendIds.has(a.id)&&!pendingIds.has(a.id)).map(a=>socialCard(a.id)).filter(Boolean).slice(0,40);res.json({me:socialProfile(me),friends,incoming,outgoing,discover})});
app.post('/api/social/profile',(req,res)=>{const me=authenticatedAccount(req,res);if(!me)return;const name=clean(req.body?.name,24)||me.name||'Player';const bio=clean(req.body?.bio,160);const rawAvatar=String(req.body?.avatar||'🌙');const avatar=rawAvatar.length<=150000&&(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(rawAvatar)||/^https:\/\//.test(rawAvatar))?rawAvatar:clean(rawAvatar,32)||'🌙';const allowedWallpapers=new Set(['lofi-night','blue-hour','warm-ember','rainy-window','anime-night','city-rain','cozy-room','star-window']);const wallpaper=allowedWallpapers.has(String(req.body?.wallpaper||''))?String(req.body.wallpaper):'lofi-night';me.name=name;me.updatedAt=Date.now();data.socialProfiles[me.id]={...(data.socialProfiles[me.id]||{}),name,bio,avatar,wallpaper,updatedAt:Date.now()};saveData();res.json({profile:socialProfile(me)})});
app.post('/api/social/request/send',(req,res)=>{const me=authenticatedAccount(req,res);if(!me)return;const target=accountById(clean(req.body?.targetId,100));if(!target||target.id===me.id)return res.status(400).json({error:'Choose a valid person to add.'});const key=pairKey(me.id,target.id);if(data.friendships[key])return res.status(409).json({error:'You are already connected.'});const pending=data.friendRequests.find(r=>r.status==='pending'&&((r.from===me.id&&r.to===target.id)||(r.from===target.id&&r.to===me.id)));if(pending)return res.status(409).json({error:'A request is already waiting.'});data.friendRequests.push({id:crypto.randomUUID(),from:me.id,to:target.id,status:'pending',createdAt:Date.now()});saveData();res.json({ok:true})});
app.post('/api/social/request/respond',(req,res)=>{const me=authenticatedAccount(req,res);if(!me)return;const request=data.friendRequests.find(r=>r.id===clean(req.body?.requestId,100)&&r.to===me.id&&r.status==='pending');if(!request)return res.status(404).json({error:'That friend request is no longer available.'});if(req.body?.accept===true){const key=pairKey(request.from,request.to);data.friendships[key]={users:[request.from,request.to],createdAt:Date.now()};data.streaks[key] ||= {current:0,best:0,lastActiveDay:null};request.status='accepted';request.respondedAt=Date.now()}else{request.status='declined';request.respondedAt=Date.now()}saveData();res.json({ok:true})});
app.post('/api/social/messages/list',(req,res)=>{const me=authenticatedAccount(req,res);if(!me)return;const otherId=clean(req.body?.friendId,100);const key=pairKey(me.id,otherId);if(!data.friendships[key])return res.status(403).json({error:'Add this person as a friend before messaging.'});res.json({messages:(data.directMessages[key]||[]).slice(-300)})});
app.post('/api/social/messages/send',(req,res)=>{const me=authenticatedAccount(req,res);if(!me)return;const otherId=clean(req.body?.friendId,100);const key=pairKey(me.id,otherId);if(!data.friendships[key])return res.status(403).json({error:'Add this person as a friend before messaging.'});const textValue=clean(req.body?.text,2000);if(!textValue)return res.status(400).json({error:'Write a message first.'});const msg={id:crypto.randomUUID(),from:me.id,to:otherId,text:textValue,time:Date.now(),readAt:null};data.directMessages[key] ||= [];data.directMessages[key].push(msg);if(data.directMessages[key].length>1000)data.directMessages[key]=data.directMessages[key].slice(-1000);saveData();res.json({message:msg})});
app.post('/api/social/messages/read',(req,res)=>{const me=authenticatedAccount(req,res);if(!me)return;const otherId=clean(req.body?.friendId,100);const key=pairKey(me.id,otherId);if(!data.friendships[key])return res.status(403).json({error:'Not connected.'});const now=Date.now();(data.directMessages[key]||[]).forEach(m=>{if(m.to===me.id&&!m.readAt)m.readAt=now});saveData();res.json({ok:true})});
app.post('/api/social/presence',(req,res)=>{const me=authenticatedAccount(req,res);if(!me)return;data.presence[me.id]=Date.now();res.json({ok:true,online:true})});

app.post('/api/access/status',(req,res)=>{const session=clean(req.body?.session,100);const accountId=data.accountSessions[session];if(!session||!accountId)return res.status(401).json({error:'Please sign in again.'});const account=Object.values(data.accounts).find(a=>a.id===accountId&&a.session===session);if(!account)return res.status(401).json({error:'Please sign in again.'});res.json({access:accessFor(account)});});
app.post('/api/auth/email',(req,res)=>{try{
 const mode=req.body?.mode==='register'?'register':'login';
 const email=String(req.body?.email||'').trim().toLowerCase();
 const password=String(req.body?.password||'');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)return res.status(400).json({error:'Enter a valid email address.'});
 if(password.length<8||password.length>256)return res.status(400).json({error:'Password must be between 8 and 256 characters.'});
 const key='email:'+email;
 let account=data.accounts[key];
 if(mode==='register'){
  if(account)return res.status(409).json({error:'An account already exists for this email. Sign in instead.'});
  const salt=crypto.randomBytes(16).toString('hex');
  const passwordHash=crypto.scryptSync(password,salt,64).toString('hex');
  account={id:crypto.randomUUID(),provider:'email',email,name:clean(req.body?.name||email.split('@')[0],24)||'Player',picture:'',passwordSalt:salt,passwordHash,createdAt:Date.now()};
 }else{
  if(!account||!account.passwordSalt||!account.passwordHash)return res.status(401).json({error:'Email or password is incorrect.'});
  const expected=Buffer.from(account.passwordHash,'hex');
  const actual=crypto.scryptSync(password,account.passwordSalt,64);
  if(expected.length!==actual.length||!crypto.timingSafeEqual(actual,expected))return res.status(401).json({error:'Email or password is incorrect.'});
 }
 account.session=token();account.updatedAt=Date.now();data.accounts[key]=account;data.accountSessions[account.session]=account.id;saveData();
 res.json({account:accountPayload(account)});
}catch(e){res.status(500).json({error:'Could not sign in right now. Please try again.'})}});
app.post('/api/auth/session',(req,res)=>{
 const session=clean(req.body?.session,100);const accountId=data.accountSessions[session];
 if(!session||!accountId)return res.status(401).json({error:'Please sign in again.'});
 const account=Object.values(data.accounts).find(a=>a.id===accountId&&a.session===session);
 if(!account)return res.status(401).json({error:'Please sign in again.'});
 res.json({account:accountPayload(account)});
});
app.post('/api/auth/google',async(req,res)=>{try{
 if(!googleClient)return res.status(503).json({error:'Google sign-in is not configured on this deployment.'});
 const ticket=await googleClient.verifyIdToken({idToken:String(req.body?.credential||''),audience:GOOGLE_CLIENT_ID});
 const p=ticket.getPayload(); if(!p?.sub)return res.status(401).json({error:'Invalid Google credential.'});
 let account=data.accounts[p.sub]||{id:crypto.randomUUID(),googleSub:p.sub,provider:'google',createdAt:Date.now()};
 account.name=clean(account.name||p.name||'Player',24)||'Player'; account.email=clean(account.email||p.email||'',160); account.picture=clean(account.picture||p.picture||'',1200); account.updatedAt=Date.now(); account.session=token();
 data.accounts[p.sub]=account; data.accountSessions[account.session]=account.id; saveData();
 res.json({account:accountPayload(account)});
}catch(e){res.status(401).json({error:'Google credential verification failed.'})}});
const QUESTIONS = {
  "Would You Rather": [
    "Would you rather plan a cozy night or let the other person surprise you?",
    "Would you rather get a sweet message or a funny voice note?",
    "Would you rather match profile pictures or wallpapers?",
    "Would you rather be teased playfully or complimented dramatically?",
    "Would you rather have a spontaneous adventure or a calm late-night chat?",
    "Bold pick: would you rather answer a super-honest harmless question or do a silly challenge?",
    "Who would you rather choose for a team: the person who makes you laugh or the person who keeps you calm?",
    "What kind of compliment would make you smile instantly?",
    "Would you rather recreate your funniest shared moment or make a brand-new one?",
    "What is one tiny thing the other person does that is ridiculously cute?",
    "Would you rather exchange favorite memories or future date ideas?",
    "Teasing round: who is more likely to say “I wasn’t being dramatic” after being dramatic?"
  ],
  "How Well Do You Know Me?": [
    "What kind of message instantly improves my mood?",
    "What would my perfect chill evening look like?",
    "What harmless thing am I most likely to get competitive about?",
    "What compliment would I probably remember for a long time?",
    "What is one cute habit you think I have?",
    "Bold round: what playful tease would make me laugh instead of annoy me?",
    "What kind of date-night activity would I choose first?",
    "What is something I would probably choose over going to bed?",
    "What is one thing I secretly enjoy being noticed for?",
    "What kind of encouragement works best on me?",
    "What memory do you think I would replay forever?",
    "Teasing round: what phrase do I probably say way too much?"
  ],
  "Guess My Answer": [
    "What would I pick for a perfect evening together?",
    "Which kind of compliment would I choose: funny, sweet, or dramatic?",
    "Would I rather talk for hours or play games for hours?",
    "What snack would I pick for movie night?",
    "What would I choose for our next online date?",
    "Bold round: which harmless challenge would I actually agree to?",
    "What would make me laugh fastest?",
    "Which vibe fits me tonight: cozy, chaotic, playful, or dreamy?",
    "What kind of surprise would I appreciate most?",
    "Would I pick a long conversation or a spontaneous game first?",
    "What would I probably choose as our shared wallpaper theme?",
    "Teasing round: what silly thing would I pretend not to care about?"
  ],
  "Truth or Dare": [
    "Truth: What is one wholesome thing you genuinely appreciate about the other player?",
    "Truth: What funny memory always makes you smile?",
    "Dare: Give the other player a ridiculous nickname for one round.",
    "Dare: Send your most dramatic emoji reaction.",
    "Truth: What tiny thing always cheers you up?",
    "Dare: Give the other player a three-word compliment.",
    "Truth: What is one harmless thing you would love to do together someday?",
    "Dare: Describe your ideal date night using only five emojis.",
    "Truth: What is one quality you really value in a close friend?",
    "Dare: Create a funny team name for both of you.",
    "Truth: What is the nicest surprise someone could plan for you?",
    "Dare: Deliver your best fake awards-show speech about your teammate."
  ],
  "Flirty / Teasing": [
    "Who gets shy first when the conversation gets extra sweet?",
    "What harmless thing does the other player do that you find adorable?",
    "Who is more likely to start a playful argument just to keep talking?",
    "What compliment would make you smile all day?",
    "Who is more likely to send a random “thinking of you” message?",
    "Bold but wholesome: what playful question would you be brave enough to ask?",
    "What is your favorite kind of friendly attention?",
    "Who is more likely to give an over-the-top compliment?",
    "What cute habit would you never want the other player to lose?",
    "If your duo had a romantic-comedy title, what would it be?",
    "What kind of wholesome surprise would feel especially sweet?",
    "Teasing round: who is more likely to deny being the more dramatic one?"
  ],
  "Draw & Guess — Live": [
    "Draw the other player as a superhero.",
    "Draw your duo as a cute cartoon.",
    "Draw your dream hangout in five minutes.",
    "Draw the funniest version of the other player.",
    "Draw a symbol that represents your friendship.",
    "Bold round: draw the most dramatic compliment you can imagine.",
    "Draw a tiny scene that would make the other player smile.",
    "Draw your shared gaming setup of the future.",
    "Draw a silly mascot for your duo.",
    "Draw a wholesome romantic-comedy poster for your duo.",
    "Draw the other player as a game character.",
    "Teasing round: draw who is more dramatic without using words."
  ],
  "Two Truths & A Lie": [
    "Share three harmless facts and let the other player guess the lie.",
    "Which fact about you would be hardest to believe?",
    "What funny habit could you use as one of your truths?",
    "What childhood hobby could become a truth?",
    "What unexpected food opinion could become a truth?",
    "Bold but wholesome: make one truth hilariously embarrassing but harmless.",
    "What random talent could you claim as a truth?",
    "What tiny achievement would make a good truth?",
    "What fictional skill would you love to have?",
    "What silly prediction about yourself could be a truth?",
    "What wholesome compliment could hide inside one of your truths?",
    "Teasing round: which player is more likely to make the lie too obvious?"
  ],
  "Reaction Race": [
    "Pick the best reaction to receiving a surprise compliment.",
    "Pick the reaction to losing by one point.",
    "Pick the reaction to a hilarious plot twist.",
    "Pick the reaction to a surprise date-night plan.",
    "Pick the reaction to being called the MVP.",
    "Bold but wholesome: pick the reaction to a dramatic but friendly tease.",
    "Pick the reaction to an unexpected win.",
    "Pick the reaction to a cute avatar change.",
    "Pick the reaction to a midnight “you awake?” message.",
    "Pick the reaction to a perfect game-night streak.",
    "Pick the reaction to a wholesome surprise.",
    "Teasing round: pick the reaction to being called the dramatic one."
  ],
  "Guess The Vibe": [
    "Guess whether the other player wants cozy, chaotic, playful, or dreamy.",
    "Guess which vibe fits their favorite game.",
    "Guess their ideal movie-night mood.",
    "Guess their reaction to a compliment.",
    "Guess whether they prefer a planned or spontaneous date night.",
    "Bold but wholesome: guess which harmless challenge they would choose.",
    "Guess their favorite kind of chat.",
    "Guess their ideal music mood.",
    "Guess what would make them laugh today.",
    "Guess which color fits their current vibe.",
    "Guess their perfect shared activity.",
    "Teasing round: guess who is secretly more competitive."
  ],
  "Card Flip": [
    "Choose a card: compliment, memory, question, or challenge.",
    "Choose a card: funny, sweet, chaotic, or cozy.",
    "Choose a card for a surprise mini challenge.",
    "Choose a card for a shared memory prompt.",
    "Choose a card for a playful question.",
    "Bold but wholesome: choose the card with the bravest harmless prompt.",
    "Choose a card for a team challenge.",
    "Choose a card for a dramatic compliment.",
    "Choose a card for a future date idea.",
    "Choose a card for a silly confession.",
    "Choose a card for a warm appreciation prompt.",
    "Teasing round: choose who gets the “most dramatic” card."
  ]
};
const DATE_NIGHTS=[
 {title:'Cozy Movie Night',desc:'Pick a movie, grab snacks, and rate it together.',ico:'🎬'},
 {title:'Anime Night',desc:'Each person picks one episode. Then compare ratings.',ico:'🍿'},
 {title:'Music Swap',desc:'Take turns choosing songs and explain why you picked them.',ico:'🎵'},
 {title:'Question Roulette',desc:'Play random questions from your favorite categories.',ico:'🎲'},
 {title:'Compliment Challenge',desc:'Give each other three genuine compliments, no repeats.',ico:'💖'},
 {title:'Draw & Guess — Live',desc:'Take turns drawing and guessing a silly prompt together.',ico:'🎨'},
 {title:'Memory Lane',desc:'Take turns sharing favorite memories and funny moments.',ico:'🫶'},
 {title:'Two Truths & A Lie',desc:'Three statements each. Guess the lie.',ico:'🎭'},
 {title:'No-Plan Night',desc:'Flip a coin for every tiny decision and see where the night goes.',ico:'🪩'}
];
const AVATARS=['🌙','✨','🦋','🐈','🐼','🦊','🐰','🐻','🐱','🌸','⭐','🍓','🎀','🩷','🖤','🌌','🌊','☁️','🌺','🪐','🍒','🪽','🐧','🦄'];
const GAMES={"Would You Rather": ["❓", "wyr", "Both answer freely. Chat, compare, then move on."], "How Well Do You Know Me?": ["🧠", "know", "One player answers privately; the other predicts."], "Guess My Answer": ["💭", "guess", "Predict what your partner would really choose."], "Truth or Dare": ["💗", "tod", "Take turns choosing Truth or Dare, then respond."], "Flirty / Teasing": ["✨", "flirty", "Playful, bold, wholesome prompts. Respond your own way."], "Draw & Guess — Live": ["🎨", "draw", "One draws live while the other guesses."], "Two Truths & A Lie": ["🎭", "two", "Three statements. Spot the lie."], "Reaction Race": ["⚡", "react", "React fast to the prompt—just for fun."], "Guess The Vibe": ["🌈", "vibe", "Predict the vibe, reveal the real vibe, talk."], "Card Flip": ["🃏", "card", "Flip a prompt card and play it out."]};
const rooms=new Map();
const MAX_CUSTOM_IMAGE=2800000;
function safeAvatar(v){const x=String(v||''); if(AVATARS.includes(x))return x; if(/^data:image\/(png|jpeg|webp|gif);base64,/i.test(x)&&x.length<=MAX_CUSTOM_IMAGE)return x; if(/^https:\/\/[-A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%]+$/.test(x)&&x.length<=1200)return x; return '🌙';}
function makeCode(){let c;do{c=Math.random().toString(36).slice(2,7).toUpperCase()}while(rooms.has(c));return c}
const COLOR_RE=/^#[0-9a-f]{6}$/i;const WALLPAPER_SET=new Set(['midnight','nebula','aurora','velvet','ocean','sunset']);const GLOW_SET=new Set(['soft','bright','max']);const DENSITY_SET=new Set(['cozy','compact']);const MOTION_SET=new Set(['smooth','calm','reduced']);const CONTRAST_SET=new Set(['balanced','crisp','soft']);function safeColor(v,fallback){const x=String(v||'');return COLOR_RE.test(x)?x:fallback}
function publicPlayer(p){return {id:p.id,playerId:p.playerId,name:p.name,avatar:p.avatar,accent:p.accent||'#72a7ff',bio:p.bio||'',wallpaper:p.wallpaper||'midnight',ready:!!p.ready,host:!!p.host,online:!!p.id,accountId:p.accountId||null}}
function publicState(room){return {version:APP_VERSION,code:room.code,phase:room.phase,category:room.category,round:room.round,totalRounds:room.totalRounds,gameMode:room.gameMode,chatEnabled:room.chatEnabled,chat:room.chat.slice(-200),musicUrl:room.musicUrl,musicPlaying:room.musicPlaying,musicPosition:room.musicPosition,musicOwnerId:room.musicOwnerId,dateNight:room.dateNight,drawStrokes:room.drawStrokes||[],stats:{games:room.gamesPlayed,streak:room.streak,bestStreak:room.bestStreak,nights:room.nights},players:[...room.members.values()].map(publicPlayer),roundStage:room.roundStage,actorId:room.actorId,predictorId:room.predictorId,prompt:room.prompt,hiddenPrompt:room.hiddenPrompt}}
function getRoom(s){return rooms.get(s.data.room)||null}
function me(room,s){return room?.players.get(s.id)||null}
function other(room,pid){return [...room.players.values()].find(p=>p.playerId!==pid)||null}
function createRoom(code){const room={code,players:new Map(),members:new Map(),phase:'lobby',category:'Would You Rather',round:0,totalRounds:5,gameMode:'Classic',chatEnabled:true,chat:[],musicUrl:'',musicPlaying:false,musicPosition:0,musicOwnerId:null,dateNight:null,gamesPlayed:0,hostPlayerId:null,streak:0,bestStreak:0,nights:0,lastCompletedDay:null,roundStage:'idle',actorId:null,predictorId:null,prompt:'',hiddenPrompt:'',answers:{},meta:{},drawStrokes:[],drawRedo:[],resultAdvanced:false};rooms.set(code,room);saveRoom(room);return room}
function serializeRoom(room){return {code:room.code,phase:room.phase,category:room.category,round:room.round,totalRounds:room.totalRounds,gameMode:room.gameMode,chatEnabled:room.chatEnabled,chat:room.chat.slice(-200),musicUrl:room.musicUrl,musicPlaying:room.musicPlaying,musicPosition:room.musicPosition,musicOwnerId:room.musicOwnerId,dateNight:room.dateNight,gamesPlayed:room.gamesPlayed,streak:room.streak,bestStreak:room.bestStreak,nights:room.nights,lastCompletedDay:room.lastCompletedDay,lastPresenceDay:room.lastPresenceDay||null,hostPlayerId:room.hostPlayerId,roundStage:room.roundStage,actorId:room.actorId,predictorId:room.predictorId,prompt:room.prompt,hiddenPrompt:room.hiddenPrompt,answers:room.answers,meta:room.meta,drawStrokes:room.drawStrokes||[],resultAdvanced:!!room.resultAdvanced,members:[...room.members.values()].map(p=>({...p,id:null,ready:false}))}}
function saveRoom(room){data.rooms[room.code]=serializeRoom(room);saveData()}
function loadRoom(code){const raw=data.rooms?.[code];if(!raw)return null;const room={...raw,players:new Map(),members:new Map(),chat:Array.isArray(raw.chat)?raw.chat:[],answers:raw.answers||{},meta:raw.meta||{},drawStrokes:Array.isArray(raw.drawStrokes)?raw.drawStrokes:[],drawRedo:[],resultAdvanced:!!raw.resultAdvanced};(raw.members||[]).forEach(p=>room.members.set(p.playerId,{...p,id:null,ready:false,host:!!p.host})); if(!room.hostPlayerId){const first=[...room.members.values()][0];room.hostPlayerId=first?.playerId||null;if(first)first.host=true;} else {room.members.forEach(m=>{m.host=m.playerId===room.hostPlayerId})} rooms.set(code,room);return room}
function addPlayer(socket,payload,room){const isFirst=room.members.size===0;const p={id:socket.id,playerId:crypto.randomUUID(),session:clean(payload?.session,100)||token(),accountId:clean(payload?.accountId,100)||null,name:clean(payload?.name,24)||'Player',avatar:safeAvatar(payload?.avatar),accent:safeColor(payload?.accent,'#72a7ff'),accent2:safeColor(payload?.accent2,'#c17cff'),bio:clean(payload?.bio,120)||'',wallpaper:WALLPAPER_SET.has(String(payload?.wallpaper||''))?String(payload.wallpaper):'midnight',glow:GLOW_SET.has(String(payload?.glow||''))?String(payload.glow):'soft',density:DENSITY_SET.has(String(payload?.density||''))?String(payload.density):'cozy',motion:MOTION_SET.has(String(payload?.motion||''))?String(payload.motion):'reduced',contrast:CONTRAST_SET.has(String(payload?.contrast||''))?String(payload.contrast):'balanced',ready:false,host:isFirst}; if(isFirst)room.hostPlayerId=p.playerId; room.players.set(socket.id,p);room.members.set(p.playerId,p); socket.data.room=room.code; socket.data.playerId=p.playerId; socket.data.session=p.session; socket.join(room.code); data.connections[p.session]={code:room.code,playerId:p.playerId,accountId:p.accountId||null}; saveData(); socket.emit('session_ready',p.session); return p}
function promptFor(room){const list=QUESTIONS[room.category]||[];return list[(room.round-1)%Math.max(list.length,1)]||'Make your own prompt.'}
function startRound(room){room.phase='game';room.round++;room.answers={};room.meta={};room.drawStrokes=[];room.drawRedo=[];room.prompt=promptFor(room);room.hiddenPrompt='';room.roundStage='open';room.resultAdvanced=false;
 const ps=[...room.members.values()].filter(p=>p?.id&&room.players.has(p.id)); const actor=ps[(room.round-1)%2]; const predictor=ps.find(p=>p!==actor); room.actorId=actor?.playerId||null; room.predictorId=predictor?.playerId||null;
 if(room.category==='Would You Rather'||room.category==='Flirty / Teasing'||room.category==='Reaction Race')room.roundStage='both'; else room.roundStage='actor';
 room.players.forEach(p=>{const sock=io.sockets.sockets.get(p.id);if(sock)sock.emit('round_started',{state:stateFor(room,p.playerId)})}); broadcast(room)}
function stateFor(room,playerId){const s=publicState(room);if(room.phase==='game'&&room.category==='Draw & Guess — Live'&&playerId!==room.actorId)s.prompt='🎨 Watch the drawing and guess what your partner is creating.';return s}
function broadcast(room){saveRoom(room);room.players.forEach(p=>{const sock=io.sockets.sockets.get(p.id);if(sock)sock.emit('state',stateFor(room,p.playerId))})}
function systemChat(room,text){const msg={id:'system-'+Date.now(),system:true,text,time:Date.now()};room.chat.push(msg);io.to(room.code).emit('chat',msg)}
function finishRound(room,extra={}){room.phase='results';room.roundStage='complete';io.to(room.code).emit('round_results',{state:publicState(room),answers:room.answers,...extra}) ;broadcast(room)}
function recordCompletion(room){room.gamesPlayed+=1;room.nights+=1;const active=[...room.players.values()].filter(p=>p.accountId).slice(0,2);if(active.length===2)markPairStreak(active[0].accountId,active[1].accountId)}
function decode(v){try{return JSON.parse(v)}catch{return v}}
io.on('connection',socket=>{
 socket.on('resume_session',session=>{const rec=data.connections?.[clean(session,100)];if(!rec)return socket.emit('resume_failed');let room=rooms.get(rec.code)||loadRoom(rec.code);if(!room)return socket.emit('resume_failed');const saved=room.members.get(rec.playerId);if(!saved)return socket.emit('resume_failed');const oldSocketId=saved.id; if(oldSocketId && oldSocketId!==socket.id) room.players.delete(oldSocketId); saved.id=socket.id; saved.session=clean(session,100); room.players.set(socket.id,saved); socket.data.room=room.code; socket.data.playerId=saved.playerId; socket.data.session=saved.session; socket.join(room.code); broadcast(room); socket.emit('resume_ok',stateFor(room,saved.playerId))});
 socket.on('create_room',(payload,ack)=>{try{const room=createRoom(makeCode());addPlayer(socket,payload,room);broadcast(room);if(typeof ack==='function')ack(true,'Room created')}catch(e){if(typeof ack==='function')ack(false,'Could not create the private room')}});
 socket.on('join_room',(payload,ack)=>{try{const code=clean(payload?.code,8).toUpperCase();const room=rooms.get(code)||loadRoom(code);if(!room){if(typeof ack==='function')ack(false,'Room not found.');return}const existing=[...room.members.values()].find(x=>x.session===clean(payload?.session,100));if(room.members.size>=2 && !existing){if(typeof ack==='function')ack(false,'That room already has two players.');return}if(existing){const oldSocketId=existing.id;if(oldSocketId && oldSocketId!==socket.id){room.players.delete(oldSocketId);const oldSock=io.sockets.sockets.get(oldSocketId);if(oldSock)oldSock.leave(room.code)}existing.id=socket.id;room.players.set(socket.id,existing);socket.data.room=room.code;socket.data.playerId=existing.playerId;socket.data.session=existing.session;socket.join(room.code);socket.emit('session_ready',existing.session);broadcast(room);if(typeof ack==='function')ack(true,'Reconnected');return}addPlayer(socket,payload,room);systemChat(room,(clean(payload?.name,24)||'Player')+' connected.');broadcast(room);if(typeof ack==='function')ack(true,'Joined room')}catch(e){if(typeof ack==='function')ack(false,'Could not join the room')}});
 socket.on('update_profile',payload=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p)return;p.name=clean(payload?.name,24)||p.name;p.avatar=safeAvatar(payload?.avatar);p.accent=safeColor(payload?.accent,p.accent||'#72a7ff');p.accent2=safeColor(payload?.accent2,p.accent2||'#c17cff');p.bio=clean(payload?.bio,120);const wall=String(payload?.wallpaper||'');p.wallpaper=WALLPAPER_SET.has(wall)?wall:p.wallpaper||'midnight';const glow=String(payload?.glow||'');p.glow=GLOW_SET.has(glow)?glow:p.glow||'soft';const density=String(payload?.density||'');p.density=DENSITY_SET.has(density)?density:p.density||'cozy';const motion=String(payload?.motion||'');p.motion=MOTION_SET.has(motion)?motion:p.motion||'smooth';const contrast=String(payload?.contrast||'');p.contrast=CONTRAST_SET.has(contrast)?contrast:p.contrast||'balanced';if(p.session)data.connections[p.session]={code:room.code,playerId:p.playerId,accountId:p.accountId||null};saveRoom(room);broadcast(room)});
 socket.on('set_ready',(v,ack)=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p||room.phase!=='lobby'){if(typeof ack==='function')ack(false,'Ready status is unavailable right now.');return}p.ready=!!v;saveRoom(room);broadcast(room);if(typeof ack==='function')ack(true,p.ready?'Ready':'Not ready')});
 socket.on('set_category',(c,ack)=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p){if(typeof ack==='function')ack(false,'Join a private room first.');return}if(p.playerId!==room.hostPlayerId){if(typeof ack==='function')ack(false,'Only the room host can choose the game.');return}if(room.phase!=='lobby'||!QUESTIONS[c]){if(typeof ack==='function')ack(false,'Game setup is not available right now.');return}room.category=c;room.players.forEach(x=>x.ready=false);saveRoom(room);broadcast(room);if(typeof ack==='function')ack(true,'Game selected')});
 socket.on('set_rounds',(n,ack)=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p){if(typeof ack==='function')ack(false,'Join a private room first.');return}if(p.playerId!==room.hostPlayerId){if(typeof ack==='function')ack(false,'Only the room host can change rounds.');return}if(room.phase!=='lobby'){if(typeof ack==='function')ack(false,'Game setup is locked.');return}room.totalRounds=Math.max(3,Math.min(10,Number(n)||5));if(room.gameMode==='Quick Play')room.totalRounds=Math.min(3,room.totalRounds);room.players.forEach(x=>x.ready=false);saveRoom(room);broadcast(room);if(typeof ack==='function')ack(true,'Rounds updated')});
 socket.on('set_mode',(m,ack)=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p){if(typeof ack==='function')ack(false,'Join a private room first.');return}if(p.playerId!==room.hostPlayerId){if(typeof ack==='function')ack(false,'Only the room host can change mode.');return}if(room.phase!=='lobby'||!['Classic','Chaos','Quick Play'].includes(m)){if(typeof ack==='function')ack(false,'Game setup is locked.');return}room.gameMode=m;if(m==='Quick Play')room.totalRounds=Math.min(3,room.totalRounds);room.players.forEach(x=>x.ready=false);saveRoom(room);broadcast(room);if(typeof ack==='function')ack(true,'Mode updated')});
 socket.on('start_game',(payload,ack)=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p){if(typeof ack==='function')ack(false,'Join a private room first.');return}if(p.playerId!==room.hostPlayerId){if(typeof ack==='function')ack(false,'Only the room host can start the game.');return}if(room.phase!=='lobby'){if(typeof ack==='function')ack(false,'That game is already in progress.');return}if(room.players.size!==2){if(typeof ack==='function')ack(false,'Both players need to be connected first.');return}room.round=0;saveRoom(room);startRound(room);if(typeof ack==='function')ack(true,'Game started')});
 socket.on('submit_turn',payload=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p||room.phase!=='game')return;const cat=room.category;const type=clean(payload?.type,40);let value=payload?.value;if(typeof value==='string')value=clean(value,2500);const isActor=p.playerId===room.actorId;const isPredictor=p.playerId===room.predictorId;
   if(room.roundStage==='both'&&(cat==='Would You Rather'||cat==='Flirty / Teasing'||cat==='Reaction Race')){if(room.answers[p.playerId]!=null)return;room.answers[p.playerId]=value;if(Object.keys(room.answers).length===2)finishRound(room);else{room.roundStage='both_wait';broadcast(room)}return}
   if(cat==='Draw & Guess — Live'){if(type==='draw_done'&&isActor){room.roundStage='predictor';room.answers[room.actorId]='drawing-complete';broadcast(room)}else if(type==='guess'&&isPredictor){room.answers[room.predictorId]=value;finishRound(room,{guess:value})}return}
   if(cat==='How Well Do You Know Me?'||cat==='Guess My Answer'){if(room.roundStage==='actor'&&isActor){room.answers[room.actorId]=value;room.roundStage='predictor';broadcast(room)}else if(room.roundStage==='predictor'&&isPredictor){room.answers[room.predictorId]=value;finishRound(room,{actorAnswer:room.answers[room.actorId],prediction:value})}return}
   if(cat==='Truth or Dare'){if(room.roundStage==='actor'&&isActor){room.meta.choice=clean(payload?.choice,12)||'Truth';room.answers[room.actorId]=value;finishRound(room,{choice:room.meta.choice,response:value})}return}
   if(cat==='Two Truths & A Lie'){if(room.roundStage==='actor'&&isActor){room.answers[room.actorId]=value;room.meta.lieIndex=Number(payload?.lieIndex);room.roundStage='predictor';broadcast(room)}else if(room.roundStage==='predictor'&&isPredictor){finishRound(room,{statements:decode(room.answers[room.actorId]),lieIndex:room.meta.lieIndex,pick:Number(payload?.lieIndex)})}return}
   if(cat==='Guess The Vibe'){if(room.roundStage==='actor'&&isActor){room.meta.actual=clean(value,20);room.roundStage='predictor';broadcast(room)}else if(room.roundStage==='predictor'&&isPredictor){room.meta.prediction=clean(value,20);finishRound(room,{actual:room.meta.actual,prediction:room.meta.prediction})}return}
   if(cat==='Card Flip'){if(room.roundStage==='actor'&&isActor){room.meta.card=clean(value,30);finishRound(room,{card:room.meta.card})}return}
 });
 socket.on('next_round',(ack)=>{const room=getRoom(socket);if(!room||room.phase!=='results'||room.resultAdvanced){if(typeof ack==='function')ack(false,'The round is not ready to advance.');return;}room.resultAdvanced=true;if(room.round>=room.totalRounds){recordCompletion(room);room.phase='complete';room.roundStage='complete';saveRoom(room);io.to(room.code).emit('night_complete',{state:publicState(room)});broadcast(room);systemChat(room,'Night complete — shared streak updated.')}else startRound(room);if(typeof ack==='function')ack(true,'Round advanced')});
 socket.on('refresh_round',(ack)=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p||room.phase!=='game')return typeof ack==='function'&&ack(false,'There is no active game round.');room.answers={};room.meta={};room.roundStage=(room.category==='Would You Rather'||room.category==='Flirty / Teasing'||room.category==='Reaction Race')?'both':'actor';room.drawStrokes=[];room.drawRedo=[];saveRoom(room);room.players.forEach(p=>{const sock=io.sockets.sockets.get(p.id);if(sock)sock.emit('round_started',{state:stateFor(room,p.playerId),refresh:true})});broadcast(room);if(typeof ack==='function')ack(true,'Round refreshed')});
 socket.on('skip_question',(ack)=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p||room.phase!=='game')return typeof ack==='function'&&ack(false,'There is no active game round.');const list=QUESTIONS[room.category]||[];const current=room.prompt;let next=current;for(let tries=0;tries<8&&next===current;tries++){next=list.length?list[Math.floor(Math.random()*list.length)]:'Make your own prompt.'}room.prompt=next;room.answers={};room.meta={};room.roundStage=(room.category==='Would You Rather'||room.category==='Flirty / Teasing'||room.category==='Reaction Race')?'both':'actor';room.drawStrokes=[];room.drawRedo=[];saveRoom(room);room.players.forEach(p=>{const sock=io.sockets.sockets.get(p.id);if(sock)sock.emit('round_started',{state:stateFor(room,p.playerId),skipped:true})});broadcast(room);systemChat(room,`${p.name} skipped the question.`);if(typeof ack==='function')ack(true,'Question skipped')});
 socket.on('end_game',(ack)=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p)return typeof ack==='function'&&ack(false,'Join a private room first.');room.phase='lobby';room.round=0;room.roundStage='idle';room.actorId=null;room.predictorId=null;room.prompt='';room.hiddenPrompt='';room.answers={};room.meta={};room.drawStrokes=[];room.drawRedo=[];room.players.forEach(x=>x.ready=false);saveRoom(room);io.to(room.code).emit('game_ended',{state:publicState(room)});broadcast(room);systemChat(room,`${p.name} ended the game.`);if(typeof ack==='function')ack(true,'Game ended')});
 socket.on('rematch',(ack)=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p)return typeof ack==='function'&&ack(false,'Join a private room first.');if(p.playerId!==room.hostPlayerId)return typeof ack==='function'&&ack(false,'Only the room host can rematch the room.');room.phase='lobby';room.round=0;room.roundStage='idle';room.answers={};room.meta={};room.players.forEach(p=>p.ready=false);saveRoom(room);broadcast(room);if(typeof ack==='function')ack(true,'Lobby reset')});
 socket.on('date_night',()=>{const room=getRoom(socket);if(!room)return;room.dateNight=DATE_NIGHTS[Math.floor(Math.random()*DATE_NIGHTS.length)];room.nights+=1;saveRoom(room);broadcast(room);io.to(room.code).emit('date_night_pick',room.dateNight)});
 socket.on('chat',(text,ack)=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p||!room.chatEnabled){if(typeof ack==='function')ack(false,'Chat is unavailable right now.');return}const t=clean(text,800);if(!t){if(typeof ack==='function')ack(false,'Message is empty.');return}const msg={id:socket.id+'-'+Date.now(),name:p.name,avatar:p.avatar,text:t,time:Date.now()};room.chat.push(msg);if(room.chat.length>200)room.chat.shift();saveRoom(room);io.to(room.code).emit('chat',msg);if(typeof ack==='function')ack(true,msg)});
 socket.on('typing',v=>{const room=getRoom(socket),p=me(room,socket);if(room&&p)socket.to(room.code).emit('typing',v?p.name:null)});
 socket.on('music_load',url=>{const room=getRoom(socket);if(!room)return;const m=String(url||'').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/);if(!m)return socket.emit('error_message','Paste a valid YouTube link.');room.musicUrl=m[1];room.musicPosition=0;room.musicPlaying=false;room.musicOwnerId=socket.data.playerId||null;saveRoom(room);io.to(room.code).emit('music_sync',{type:'load',id:room.musicUrl,position:0,ownerId:room.musicOwnerId});broadcast(room)});
 socket.on('music_command',p=>{const room=getRoom(socket);if(!room||!room.musicUrl)return;const t=p?.type;if(!['play','pause','seek'].includes(t))return;if(t==='seek'&&room.musicOwnerId&&room.musicOwnerId!==socket.data.playerId)return;if(t==='seek')room.musicPosition=Math.max(0,Number(p.position)||0);else {room.musicPlaying=t==='play';room.musicOwnerId=socket.data.playerId||room.musicOwnerId;}saveRoom(room);io.to(room.code).emit('music_sync',{type:t,position:room.musicPosition,ownerId:room.musicOwnerId});broadcast(room)});
 socket.on('draw_stroke',d=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p||room.phase!=='game'||room.category!=='Draw & Guess — Live'||p.playerId!==room.actorId)return;const norm=v=>[Math.min(1,Math.max(0,Number(v?.[0])||0)),Math.min(1,Math.max(0,Number(v?.[1])||0))];const seg={strokeId:clean(d?.strokeId,80)||crypto.randomUUID(),from:norm(d?.from),to:norm(d?.to),color:safeColor(d?.color,'#72a7ff'),width:Math.max(2,Math.min(28,Number(d?.width)||6)),tool:d?.tool==='eraser'?'eraser':'pen'};room.drawStrokes.push(seg);if(room.drawStrokes.length>2500)room.drawStrokes.splice(0,room.drawStrokes.length-2500);room.drawRedo=[];socket.to(room.code).emit('draw_stroke',seg);saveRoom(room)});
 socket.on('draw_clear',()=>{const room=getRoom(socket),p=me(room,socket);if(room&&p&&room.category==='Draw & Guess — Live'&&p.playerId===room.actorId){room.drawStrokes=[];room.drawRedo=[];saveRoom(room);io.to(room.code).emit('draw_clear')}});
 socket.on('draw_undo',()=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p||room.category!=='Draw & Guess — Live'||p.playerId!==room.actorId||!room.drawStrokes.length)return;const id=room.drawStrokes[room.drawStrokes.length-1].strokeId;const group=room.drawStrokes.filter(x=>x.strokeId===id);room.drawStrokes=room.drawStrokes.filter(x=>x.strokeId!==id);room.drawRedo.push(group);saveRoom(room);io.to(room.code).emit('draw_sync',{strokes:room.drawStrokes})});
 socket.on('draw_redo',()=>{const room=getRoom(socket),p=me(room,socket);if(!room||!p||room.category!=='Draw & Guess — Live'||p.playerId!==room.actorId||!room.drawRedo.length)return;const group=room.drawRedo.pop();room.drawStrokes.push(...group);saveRoom(room);io.to(room.code).emit('draw_sync',{strokes:room.drawStrokes})});
 socket.on('disconnect',()=>{const room=getRoom(socket);if(!room)return;const p=room.players.get(socket.id);if(!p)return;p.id=null;room.players.delete(socket.id);saveRoom(room);broadcast(room)});
});
const PORT=process.env.PORT||3000;server.listen(PORT,()=>console.log(`Game Night ${APP_VERSION} listening on ${PORT}`));
