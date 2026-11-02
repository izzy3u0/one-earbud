'use strict';
// MCP UI adapter. Music resolution, queue, commands and heartbeat remain authority-owned.
const { randomBytes, randomUUID } = require('node:crypto');
const https = require('node:https');
function mediaUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && /(^|\.)music\.(126\.net|163\.com)$/.test(u.hostname) ? u : null;
  } catch (_) { return null; }
}
function createWidgetPlayback({ authority, publicUrl = '', now = Date.now, upstream = https.request }) {
  const sessions = new Map(), tickets = new Map(), writes = new Map(), acquisitions = new Map();
  const failure = (error,message) => ({ structuredContent:{ ok:false,error,message },isError:true,content:[{type:'text',text:message}] });
  function reply(extra = {}, meta = {}) {
    const result = { ok:true,playback:authority.playbackOwner(),...extra };
    return { structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}],_meta:meta };
  }
  function valid(input) { return authority.playbackOwner().mode === 'chatgpt' && authority.ownsNowPlaying(input); }
  function select(session, songId, positionMs, playing) {
    session.songId = String(songId); session.trackId = randomUUID(); session.positionMs = positionMs || 0;
    session.trackVersion=(session.trackVersion||0)+1;
    session.playing = !!playing; session.audio = null;
  }
  function move(session,direction) {
    const q=authority.queue.get(), at=q.items.findIndex(x=>String(x.songId)===session.songId && (x.id===q.currentId));
    if (!q.items.length) return;
    let index=direction==='previous' ? (at-1+q.items.length)%q.items.length : (at+1)%q.items.length;
    if (direction==='ended' && q.mode==='one' && at>=0) index=at;
    else if (direction!=='previous' && q.mode==='shuffle' && q.items.length>1) { do {index=Math.floor(Math.random()*q.items.length);} while(index===at); }
    const item=q.items[index]; authority.queue.setCurrent({by:'you',id:item.id}); select(session,item.songId,0,direction==='ended'||session.playing);
  }
  async function descriptor(session) {
    if (!session.songId) return null;
    if (session.audio && session.audio.expiresAt>now()+30000) return session.audio;
    const trackId=session.trackId, [song, playback]=await Promise.all([authority.song(session.songId),authority.playUrl(session.songId)]);
    const url=mediaUrl(playback.url);
    if (!url) throw new Error('untrusted_media');
    if (!valid(session) || trackId!==session.trackId || authority.playbackOwner().handoff) return null;
    const token=randomBytes(24).toString('base64url'), expiresAt=now()+10*60*1000;
    for (const [key,ticket] of tickets) if(ticket.expiresAt<=now()) tickets.delete(key);
    if(tickets.size>=100) tickets.delete(tickets.keys().next().value);
    tickets.set(token,{url,session,trackId,expiresAt});
    session.audio={song:{songId:String(song.songId),title:String(song.title||''),artist:String(song.artist||''),coverUrl:song.coverUrl||'',durationMs:Number(song.durationMs)||0},lyrics:song.lyrics||[],trackId,trackVersion:session.trackVersion,streamId:session.streamId,modeEpoch:session.modeEpoch,positionMs:session.positionMs,playing:session.playing,url:publicUrl+'/widget-media/'+token,expiresAt};
    return session.audio;
  }
  async function run(input) {
    const owner=authority.playbackOwner();
    if(input.op==='switch') {
      const result=authority.switchPlayback(input);
      if(!result.ok) return failure(result.error,'播放端已变化或仍在切换，请刷新后重试。');
      // The owning widget has already physically paused before sending this acknowledgement.
      if(input.sessionId && authority.ownsNowPlaying(input) && result.playback.handoff) authority.acknowledgeHandoff({...input,handoffId:result.playback.handoff.id});
      return reply();
    }
    if(input.op==='ack') return reply({accepted:authority.acknowledgeHandoff(input)});
    if(input.op==='release') return reply({accepted:valid(input)&&authority.releasePlayback(input)});
    if(input.op==='report') {
      const session=sessions.get(input.sessionId);
      if(!session || !valid(input) || input.trackId!==session.trackId || input.songId!==session.songId) return reply({accepted:false});
      const accepted=authority.reportNowPlaying({...input,title:session.audio?.song.title||'',artist:session.audio?.song.artist||'',durationMs:session.audio?.song.durationMs||0});
      if(accepted) {session.positionMs=input.positionMs;session.playing=input.playing;}
      return reply({accepted});
    }
    if(owner.mode!=='chatgpt' || owner.sourceId!==input.sourceId || owner.handoff) return reply();
    let lease,session;
    if(input.op==='claim') {
      if(!input.requestId || input.expectedEpoch!==owner.epoch || input.expectedStreamId!==owner.streamId)return failure('PLAYBACK_CHANGED','播放端已变化，请重新选择。');
      const existing=acquisitions.get(input.requestId);
      if(existing) {
        if(existing.sourceId!==input.sourceId)return failure('REQUEST_ID_CONFLICT','请求标识已被使用。');
        if(!valid(existing))return reply();
        lease=existing;
      } else {
        lease=authority.claimNowPlaying({sourceId:input.sourceId,active:true,playbackMode:'chatgpt',modeEpoch:owner.epoch});
        if(!lease)return reply();
        acquisitions.set(input.requestId,{...lease,sourceId:input.sourceId});if(acquisitions.size>100)acquisitions.delete(acquisitions.keys().next().value);
      }
      session=sessions.get(lease.sessionId);
    } else {
      session=sessions.get(input.sessionId);
      if(!session || !valid(input))return reply();
      lease=session;
    }
    if(!session) {
      session={...lease,sourceId:input.sourceId};sessions.set(lease.sessionId,session);
      if(sessions.size>30) sessions.delete(sessions.keys().next().value);
      const cur=authority.nowPlaying(), q=authority.queue.get(), saved=owner.resume, item=q.items.find(x=>x.id===q.currentId);
      const song=saved?.songId?saved:cur||item;
      if(song) select(session,song.songId,cur?.songId===song.songId?cur.positionMs:saved?.positionMs||0,!!saved?.playing);
    }
    if(input.op==='track') {
      const old=writes.get(input.requestId);
      if(old) return old.signature===JSON.stringify([input.sessionId,input.trackId,input.direction])?reply():failure('REQUEST_ID_CONFLICT','重试请求不能用于不同操作。');
      if(!input.requestId || !['next','previous','ended'].includes(input.direction) || !valid(input) || input.sessionId!==session.sessionId || input.trackId!==session.trackId) return failure('PLAYBACK_CHANGED','歌曲或播放端已变化，请刷新。');
      writes.set(input.requestId,{signature:JSON.stringify([input.sessionId,input.trackId,input.direction])});if(writes.size>100)writes.delete(writes.keys().next().value);
      move(session,input.direction);
      if (typeof input.playing==='boolean') session.playing=input.playing;
    }
    const sync=authority.playbackSync(),command=sync.command && sync.command.at>(owner.resume?.at||0)?sync.command:null;
    if(command && session.commandId!==command.id && !command.action) {
      session.commandId=command.id;const item=sync.queue.items.find(x=>x.id===command.itemId);
      if(item)select(session,item.songId,0,authority.nowPlaying()?.state==='playing');
    }
    let audio;
    try {audio=await descriptor(session);}catch(_){return reply({audioError:'这首暂时无法在 ChatGPT 播放，可重试或切回手机 PWA。'},{lease:{sessionId:lease.sessionId,sourceId:session.sourceId}});}
    return reply({}, {lease:{sessionId:lease.sessionId,sourceId:session.sourceId},audio,command:command?.action?command:null});
  }
  async function handle(input) {
    try {return await run(input);} catch (_) {return failure('WIDGET_AUDIO_UNAVAILABLE','这首暂时无法在 ChatGPT 播放，可重试或切回手机 PWA。');}
  }
  function serve(req,res) {
    const ticket=tickets.get(req.params.ticket);
    res.set({'Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
    if(!ticket || ticket.expiresAt<=now() || !valid(ticket.session) || ticket.trackId!==ticket.session.trackId) return res.status(403).end();
    const range=req.headers.range;
    if(range && !/^bytes=\d*-\d*$/.test(range))return res.status(416).end();
    let connection,remote,done=false;
    const stop=()=>{done=true;connection?.destroy();remote?.destroy();};
    res.on('close',stop);
    function open(url,remaining) {
      connection=upstream(url,{method:req.method==='HEAD'?'HEAD':'GET',headers:range?{Range:range}:{},timeout:15000},response=>{
        remote=response;
        if(done){response.destroy();return;}
        if([301,302,303,307,308].includes(response.statusCode)) {
          let next=null;try{if(response.headers.location)next=mediaUrl(new URL(response.headers.location,url).href);}catch(_){}response.resume();
          if(next&&remaining>0)return open(next,remaining-1);
          return res.status(502).end();
        }
        if(![200,206,416].includes(response.statusCode)){response.resume();return res.status(502).end();}
        const type=String(response.headers['content-type']||'audio/mpeg').split(';')[0];
        if(response.statusCode!==416 && !/^(audio\/|application\/octet-stream$)/.test(type)){response.resume();return res.status(502).end();}
        res.status(response.statusCode);res.set('Content-Type',type);
        for(const key of ['content-length','content-range','accept-ranges']) if(response.headers[key])res.set(key,response.headers[key]);
        response.on('data',()=>{if(!valid(ticket.session)||ticket.trackId!==ticket.session.trackId){stop();res.destroy();}});
        response.on('error',()=>res.destroy());response.pipe(res);
      });
      connection.on('timeout',()=>connection.destroy(new Error('media_timeout')));connection.on('error',()=>{if(!res.headersSent)res.status(502).end();else res.destroy();});connection.end();
    }
    open(ticket.url,3);
  }
  return {handle,serve};
}
module.exports={createWidgetPlayback,mediaUrl};
