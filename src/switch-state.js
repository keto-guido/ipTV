'use strict';
function createSwitchState(notify = () => {}) {
  let current = null;
  return {
    request(channel, switchedAt = Date.now()) {
      if (current && current.id === channel.id) return;
      switchedAt = Math.max(switchedAt, current ? current.switchedAt + 1 : switchedAt);
      current = { ...channel, switchedAt, switchSeq: null, switchPdt: null };
      notify({ ...current });
    },
    boundary(id, segment, rendition = 'tv') {
      if (!current || current.id !== id) return;
      if (rendition === 'phone') {
        if (current.phoneSwitch) return;
        current.phoneSwitch = { switchSeq: segment.seq, switchPdt: new Date(segment.pdt).toISOString() };
      } else {
        if (current.switchSeq !== null) return;
        current.switchSeq = segment.seq;
        current.switchPdt = new Date(segment.pdt).toISOString();
      }
      notify({ ...current });
    },
    fields(channel) {
      const s = current && channel && current.id === channel.id ? current : null;
      return { switchedAt: s ? s.switchedAt : null, switchSeq: s ? s.switchSeq : null, switchPdt: s ? s.switchPdt : null, ...(s && s.phoneSwitch ? { phoneSwitch: s.phoneSwitch } : {}) };
    },
  };
}
module.exports = { createSwitchState };
