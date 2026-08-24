import http from 'node:http';
const handler = (req, res) => { res.end('ok'); };
const a = http.createServer(handler);
const b = http.createServer(handler);
a.listen(9312, '127.0.0.1', () => console.log('v4 up'));
b.listen(9312, '::1', () => console.log('v6 up'));
a.on('error', (e) => console.log('a err', e.code));
b.on('error', (e) => console.log('b err', e.code));
setTimeout(() => {
  fetch('http://127.0.0.1:9312/').then(r => r.text()).then(t => console.log('curl v4:', t)).catch(e => console.log('curl v4 err', e.message));
  fetch('http://[::1]:9312/').then(r => r.text()).then(t => console.log('curl v6:', t)).catch(e => console.log('curl v6 err', e.message));
}, 800);
