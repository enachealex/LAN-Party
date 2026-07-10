#!/usr/bin/env node
(async () => {
  const SERVER = 'http://localhost:3000'
  const username = `smoketest_${Date.now().toString(36).slice(-6)}`
  const email = `${username}@example.com`
  const password = 'TestPass123!'
  try {
    console.log('Registering', username, email)
    let res = await fetch(`${SERVER}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, passwordConfirm: password })
    })
    console.log('/auth/register', res.status, await res.text())

    res = await fetch(`${SERVER}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
    const login = await res.json().catch(async () => { const t = await res.text(); console.log('/auth/login raw', t); return {} })
    console.log('/auth/login', res.status, login)
    if (!login.token) {
      console.error('No token received; aborting')
      process.exit(2)
    }
    const token = login.token

    res = await fetch(`${SERVER}/auth/me`, { headers: { 'Authorization': `Bearer ${token}` } })
    console.log('/auth/me', res.status, await res.json())

    res = await fetch(`${SERVER}/user/sync`, { headers: { 'Authorization': `Bearer ${token}` } })
    const sync = await res.json()
    console.log('/user/sync', res.status, Object.keys(sync.servers || {}))

    console.log('Smoke test completed successfully')
    process.exit(0)
  } catch (err) {
    console.error('Smoke test error', err)
    process.exit(1)
  }
})()
