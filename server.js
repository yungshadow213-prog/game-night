const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const DATA_FILE = path.join(__dirname, 'gamenight-data.json');
let sharedData = {};
try { sharedData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { sharedData = {}; }
function saveData(){ try { fs.writeFileSync(DATA_FILE, JSON.stringify(sharedData, null, 2)); } catch {} }

const AVATARS = ['🌙','✨','🦋','🐈','🐼','🦊','🐰','🐻','🐱','🌸','⭐','🍓','🎀','🩷','🖤','🌌'];
const QUESTIONS = {
  'Would You Rather': [
    'Would you rather have a surprise date planned for you or plan one together?',
    'Would you rather spend a whole day watching anime or listening to music together?',
    'Would you rather always know what the other is thinking or always know what they want?',
    'Would you rather get matching avatars or matching wallpapers?',
    'Would you rather have a cozy movie night or an adventurous day out?',
    'Would you rather receive a handwritten note or a surprise voice message?'
  ],
  'How Well Do You Know Me?': [
    'What is one thing I can talk about for hours?',
    'What kind of night would make me happiest?',
    'Which fictional character do I relate to most?',
    'What is something that instantly improves my mood?',
    'What is my ideal way to relax?',
    'What is one thing I would probably spend too much money on?'
  ],
  'Guess My Answer': [
    'If I could teleport anywhere tonight, where would I go?',
    'Which song would I pick for our current vibe?',
    'What would I choose for a perfect late-night snack?',
    'Which game would I pick if we had one hour left?',
    'What would I choose for our next date-night theme?',
    'What would make me laugh immediately?'
  ],
  'Couple Quiz': [
    'Who is more likely to start a random conversation at midnight?',
    'Who is more likely to remember tiny details?',
    'Who is more likely to suggest a spontaneous plan?',
    'Who is more likely to fall asleep first?',
    'Who is more likely to make the other laugh when they are quiet?',
    'Who is more likely to say “one more round” and mean five more?'
  ],
  'Truth or Dare — Lite': [
    'Truth: What is one wholesome thing you genuinely appreciate about me?',
    'Truth: What is a funny memory you would never want us to forget?',
    'Dare: Send your best dramatic reaction using only emojis.',
    'Dare: Give the other player a ridiculous nickname for one round.',
    'Truth: What tiny thing always makes you smile?',
    'Dare: Do your most exaggerated “game show host” introduction.'
  ],
  'Flirty / Teasing': [
    'Who gets shy first when the conversation becomes extra sweet?',
    'What is something I do that you secretly find adorable?',
    'Who is more likely to start a playful argument just to keep talking?',
    'What compliment from me would make you smile all day?',
    'Who is more likely to send a random “I miss you” message?',
    'What is one cute habit of mine you would never want me to lose?',
    'If our relationship had a theme song, what would its vibe be?',
    'What is your favorite kind of attention from me?'
  ]
};
const DATE_NIGHTS = [
  {title:'Cozy Movie Night', desc:'Pick a movie, grab snacks, and rate it together.'},
  {title:'Anime Night', desc:'Each person picks one episode. Then compare ratings.'},
  {title:'Music Swap', desc:'Take turns choosing songs and explain why you picked them.'},
  {title:'Question Roulette', desc:'Play 10 random questions from your favorite categories.'},
  {title:'Compliment Challenge', desc:'Give each other three genuine compliments, no repeats.'},
  {title:'Drawing Duel', desc:'Choose a silly prompt and draw for five minutes.'},
  {title:'Memory Lane', desc:'Take turns sharing favorite memories and funny moments.'},
  {title:'Two Truths & A Lie', desc:'Three statements each. Guess the lie.'},
  {title:'Mini Tournament', desc:'Play three quick games and crown the night champion.'},
  {title:'No-Plan Night', desc:'Flip a coin for every tiny decision and see where the night goes.'}
];

const clean = (v,n=100)=>String(v??'').replace(/[<>]/g,'').trim().slice(0,n);
const safeAvatar = v=>AVATARS.includes(v)?v:'🌙';
const makeCode=()=>Math.random().toString(36).slice(2,7).toUpperCase();
const dayKey=()=>new Date().toISOString().slice(0,10);

function roomStats(room){
  const scores=[...room.players.values()].map(p=>p.score);
  const top=Math.max(0,...scores);
  return { games:room.gamesPlayed, sharedPoints:room.sharedPoints, streak:room.streak, bestStreak:room.bestStreak, topScore:top };
}
function publicState(room){
  return {
    code:room.code,
    players:[...room.players.values()].map(p=>({id:p.id,name:p.name,avatar:p.avatar,ready:p.ready,score:p.score,personalStreak:p.personalStreak,answered:p.answered})),
    phase:room.phase, round:room.round, totalRounds:room.totalRounds,
    category:room.category, question:room.question, music:room.music,
    gameMode:room.gameMode, chatEnabled:room.chatEnabled,
    dateNight:room.dateNight, stats:roomStats(room)
  };
}
function broadcast(room){ io.to(room.code).emit('state', publicState(room)); }
function getRoom(socket){ return rooms.get(socket.data.room); }
function getPlayer(room,socket){ return room?.players.get(socket.id); }
function systemChat(room,text){
  const msg={system:true,text,time:Date.now()}; room.chat.push(msg); if(room.chat.length>150)room.chat.shift(); io.to(room.code).emit('chat',msg);
}
function chooseQuestion(room){
  const list=QUESTIONS[room.category]||QUESTIONS['Would You Rather'];
  return list[(room.round-1)%list.length];
}
function startRound(room){
  room.phase='game'; room.round++; room.question=chooseQuestion(room);
  room.players.forEach(p=>{p.answered=false;p.lastAnswer=null;});
  broadcast(room); io.to(room.code).emit('round_started',{round:room.round,totalRounds:room.totalRounds,question:room.question,category:room.category});
}
function finishRound(room){
  room.phase='results';
  const scores=Object.fromEntries([...room.players.values()].map(p=>[p.id,p.score]));
  const answers=Object.fromEntries([...room.players.values()].map(p=>[p.id,p.lastAnswer]));
  broadcast(room); io.to(room.code).emit('round_results',{round:room.round,scores,answers});
}
function finishGame(room){
  room.phase='finished'; room.gamesPlayed++; room.sharedPoints += [...room.players.values()].reduce((a,p)=>a+p.score,0);
  const k=dayKey();
  if(room.lastCompletedDay!==k){
    const y=new Date(Date.now()-86400000).toISOString().slice(0,10);
    room.streak = room.lastCompletedDay===y ? room.streak+1 : 1;
    room.bestStreak=Math.max(room.bestStreak,room.streak); room.lastCompletedDay=k;
  }
  const players=[...room.players.values()];
  const winner=players.slice().sort((a,b)=>b.score-a.score)[0];
  room.lastWinner=winner?.id||null;
  saveData(); broadcast(room);
  io.to(room.code).emit('game_finished',{winnerId:room.lastWinner,stats:roomStats(room),players:players.map(p=>({id:p.id,name:p.name,avatar:p.avatar,score:p.score}))});
}
function loadShared(room){
  const d=sharedData[room.code]; if(!d)return;
  Object.assign(room,{gamesPlayed:d.gamesPlayed||0,sharedPoints:d.sharedPoints||0,streak:d.streak||0,bestStreak:d.bestStreak||0,lastCompletedDay:d.lastCompletedDay||null});
}
function saveRoom(room){
  sharedData[room.code]={gamesPlayed:room.gamesPlayed,sharedPoints:room.sharedPoints,streak:room.streak,bestStreak:room.bestStreak,lastCompletedDay:room.lastCompletedDay}; saveData();
}

io.on('connection',socket=>{
  socket.on('create_room',payload=>{
    let code; do{code=makeCode();}while(rooms.has(code));
    const room={code,players:new Map(),phase:'lobby',round:0,totalRounds:5,category:'Would You Rather',question:'',music:'romantic',chatEnabled:true,chat:[],gameMode:'Classic',dateNight:null,createdAt:Date.now(),gamesPlayed:0,sharedPoints:0,streak:0,bestStreak:0,lastCompletedDay:null,lastWinner:null};
    loadShared(room);
    const player={id:socket.id,name:clean(payload?.name,20)||'Player',avatar:safeAvatar(payload?.avatar),ready:false,score:0,personalStreak:0,answered:false,lastAnswer:null,lastChat:0};
    room.players.set(socket.id,player); rooms.set(code,room); socket.join(code); socket.data.room=code;
    socket.emit('room_created',{code}); socket.emit('chat_history',room.chat); broadcast(room);
  });

  socket.on('join_room',payload=>{
    const code=clean(payload?.code,10).toUpperCase(),room=rooms.get(code);
    if(!room)return socket.emit('error_message','Room not found.');
    if(room.players.size>=2)return socket.emit('error_message','This private room already has two players.');
    if(room.phase!=='lobby')return socket.emit('error_message','The game has already started.');
    const player={id:socket.id,name:clean(payload?.name,20)||'Player',avatar:safeAvatar(payload?.avatar),ready:false,score:0,personalStreak:0,answered:false,lastAnswer:null,lastChat:0};
    room.players.set(socket.id,player); socket.join(code); socket.data.room=code;
    socket.emit('joined_room',{code}); socket.emit('chat_history',room.chat); systemChat(room,`${player.name} joined the room.`); broadcast(room);
  });

  socket.on('update_profile',payload=>{
    const room=getRoom(socket),p=getPlayer(room,socket); if(!room||!p)return;
    p.name=clean(payload?.name,20)||p.name; p.avatar=safeAvatar(payload?.avatar); broadcast(room);
    systemChat(room,`${p.name} updated their profile.`);
  });
  socket.on('set_ready',ready=>{const room=getRoom(socket),p=getPlayer(room,socket);if(!room||!p||room.phase!=='lobby')return;p.ready=!!ready;broadcast(room);});
  socket.on('set_rounds',n=>{const room=getRoom(socket);if(!room||room.phase!=='lobby')return;room.totalRounds=Math.max(3,Math.min(10,Number(n)||5));broadcast(room);});
  socket.on('set_category',cat=>{const room=getRoom(socket);if(!room||room.phase!=='lobby'||!QUESTIONS[cat])return;room.category=cat;broadcast(room);});
  socket.on('set_music',music=>{const room=getRoom(socket);if(!room||!['romantic','phonk','off'].includes(music))return;room.music=music;broadcast(room);});
  socket.on('set_mode',mode=>{const room=getRoom(socket);if(!room||room.phase!=='lobby'||!['Classic','Chaos','Quick Play'].includes(mode))return;room.gameMode=mode;if(mode==='Quick Play')room.totalRounds=Math.min(room.totalRounds,3);broadcast(room);});
  socket.on('set_chat_enabled',enabled=>{const room=getRoom(socket);if(!room)return;room.chatEnabled=!!enabled;broadcast(room);systemChat(room,room.chatEnabled?'Chat enabled.':'Chat disabled.');});

  socket.on('start_game',()=>{const room=getRoom(socket);if(!room)return;if(room.players.size!==2)return socket.emit('error_message','Both players need to join first.');if(![...room.players.values()].every(p=>p.ready))return socket.emit('error_message','Both players need to be ready.');room.round=0;room.dateNight=null;room.players.forEach(p=>{p.score=0;p.personalStreak=0;});startRound(room);});
  socket.on('submit_answer',answer=>{const room=getRoom(socket),p=getPlayer(room,socket);if(!room||!p||room.phase!=='game'||p.answered)return;if(room.gameMode==='Chaos'&&Math.random()<0.18){p.personalStreak=0;socket.emit('answer_saved',{points:0,bonus:'Chaos twist — no points this time.'});}else{p.personalStreak++;const points=10+(p.personalStreak-1)*5;p.score+=points;socket.emit('answer_saved',{points,streak:p.personalStreak});}p.lastAnswer=clean(answer,100);p.answered=true;broadcast(room);if([...room.players.values()].every(x=>x.answered))finishRound(room);});
  socket.on('next_round',()=>{const room=getRoom(socket);if(!room||room.phase!=='results')return;if(room.round>=room.totalRounds){finishGame(room);return;}startRound(room);});
  socket.on('rematch',()=>{const room=getRoom(socket);if(!room)return;room.phase='lobby';room.round=0;room.question='';room.dateNight=null;room.players.forEach(p=>{p.ready=false;p.score=0;p.personalStreak=0;p.answered=false;p.lastAnswer=null;});broadcast(room);systemChat(room,'Rematch ready — both players can ready up again.');});
  socket.on('date_night',()=>{const room=getRoom(socket);if(!room)return;room.dateNight=DATE_NIGHTS[Math.floor(Math.random()*DATE_NIGHTS.length)];broadcast(room);systemChat(room,`Date Night pick: ${room.dateNight.title}`);io.to(room.code).emit('date_night_pick',room.dateNight);});
  socket.on('chat',text=>{const room=getRoom(socket),p=getPlayer(room,socket);if(!room||!p||!room.chatEnabled)return;const message=clean(text,300);if(!message)return;const now=Date.now();if(now-p.lastChat<700)return;p.lastChat=now;const msg={id:socket.id,name:p.name,avatar:p.avatar,text:message,time:now};room.chat.push(msg);if(room.chat.length>150)room.chat.shift();io.to(room.code).emit('chat',msg);});
  socket.on('disconnect',()=>{const room=getRoom(socket);if(!room)return;const p=room.players.get(socket.id);room.players.delete(socket.id);if(p)systemChat(room,`${p.name} left the room.`);if(room.players.size===0){saveRoom(room);rooms.delete(room.code);}else{room.phase='lobby';room.round=0;room.question='';room.players.forEach(x=>{x.ready=false;x.score=0;x.personalStreak=0;x.answered=false;});broadcast(room);}});
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Game Night running on port ${PORT}`));
