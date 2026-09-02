// Wrap RTCPeerConnection to log ICE candidates, states and the selected pair.
export function tapRTC(log) {
  const Base = globalThis.RTCPeerConnection;
  let n = 0;
  globalThis.RTCPeerConnection = class TappedPC extends Base {
    constructor(cfg) {
      super(cfg);
      const id = `pc${++n}`;
      const t0 = Date.now();
      const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
      this.addEventListener('icecandidate', (e) => {
        log(`${id} ${stamp()} local cand: ${e.candidate ? e.candidate.candidate : '(end)'}`);
      });
      for (const ev of ['connectionstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'signalingstatechange']) {
        this.addEventListener(ev, () => log(`${id} ${stamp()} ${ev}: conn=${this.connectionState} ice=${this.iceConnectionState} gath=${this.iceGatheringState} sig=${this.signalingState}`));
      }
      this.addEventListener('datachannel', (e) => log(`${id} ${stamp()} datachannel event: ${e.channel.label}`));
      const origAdd = this.addIceCandidate.bind(this);
      this.addIceCandidate = async (c) => {
        log(`${id} ${stamp()} remote cand: ${c?.candidate ?? '(end)'}`);
        try { return await origAdd(c); } catch (err) { log(`${id} addIceCandidate ERROR ${err.message}`); throw err; }
      };
      const origSetRemote = this.setRemoteDescription.bind(this);
      this.setRemoteDescription = async (d) => {
        const ufrag = /a=ice-ufrag:(\S+)/.exec(d?.sdp ?? '')?.[1];
        log(`${id} ${stamp()} setRemote ${d?.type} ufrag=${ufrag} cands=${(d?.sdp ?? '').split('\n').filter((l) => l.startsWith('a=candidate')).length}`);
        return origSetRemote(d);
      };
      const origCreate = this.createDataChannel.bind(this);
      this.createDataChannel = (label, opts) => {
        const ch = origCreate(label, opts);
        ch.addEventListener('open', () => log(`${id} ${stamp()} channel ${label} OPEN`));
        ch.addEventListener('close', () => log(`${id} ${stamp()} channel ${label} closed`));
        return ch;
      };
      this.addEventListener('connectionstatechange', async () => {
        if (this.connectionState !== 'connected' || typeof this.getStats !== 'function') return;
        try {
          const stats = await this.getStats();
          const byId = new Map(); stats.forEach((s) => byId.set(s.id, s));
          stats.forEach((s) => {
            if (s.type === 'candidate-pair' && (s.selected || s.nominated || s.state === 'succeeded')) {
              const l = byId.get(s.localCandidateId), r = byId.get(s.remoteCandidateId);
              log(`${id} ${stamp()} PAIR ${s.state} local=${l?.candidateType}:${l?.address ?? l?.ip}:${l?.port} remote=${r?.candidateType}:${r?.address ?? r?.ip}:${r?.port}`);
            }
          });
        } catch (err) { log(`${id} getStats failed: ${err.message}`); }
      });
    }
  };
}
