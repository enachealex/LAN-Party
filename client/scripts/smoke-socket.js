#!/usr/bin/env node
(async () => {
  const http = require('http')
  const io = require('socket.io-client')

  function postJSON(path, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const options = {
        hostname: 'localhost', port: 3000, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      }
      const req = http.request(options, res => {
        const bufs = []
        res.on('data', b => bufs.push(b))
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(bufs).toString())) } catch (e) { resolve(Buffer.concat(bufs).toString()) }
        })
      })
      req.on('error', reject)
      req.write(data)
      req.end()
    })
  }

  try {
    const username = `socket_${Date.now().toString(36).slice(-6)}`
    const email = `${username}@example.com`
    const password = 'TestPass123!'
    console.log('Registering', username)
    let r = await postJSON('/auth/register', { username, email, password, passwordConfirm: password })
    console.log('/auth/register', r)
    r = await postJSON('/auth/login', { username, password })
    console.log('/auth/login', r)
    const token = r.token
    if (!token) { console.error('No token received'); process.exit(2) }

    const s = io('http://localhost:3000', { auth: { token } })
    s.on('connect', () => {
      console.log('socket connected', s.id)
      s.emit('join', { serverId: 'demo', name: username })
    })
    s.on('server:state', data => console.log('server:state received', Object.keys(data.server || {})))
    s.on('messages:init', msgs => console.log('messages:init count', msgs.length))
    s.on('message', msg => console.log('message', msg))

    setTimeout(() => {
      s.disconnect();
      console.log('socket disconnected')
      process.exit(0)
    }, 6000)
  } catch (err) {
    console.error('socket test error', err)
    process.exit(1)
  }
})()
