import { createRequire } from 'module'
import fs from 'node:fs'
import { close_api, delay, send, startService } from "./utils/utils.js";
import { printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { summarizeResponse } from "./utils/safeLog.js";
import { upsertUser, saveUserinfo } from "./utils/userinfo.js";

const require = createRequire(import.meta.url)
const QRCode = require('./api/node_modules/qrcode')

// GitHub Actions 运行环境下自动注入的 Step Summary 文件路径
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY || ''
const QR_DIR = './qr'
const KEYS_FILE = './qrkeys.json'

/**
 * 向 GitHub Step Summary 追加 Markdown 内容。
 * 非 Actions 环境（本地运行）时 SUMMARY_FILE 为空，自动跳过。
 * @param {string} markdown
 */
function appendSummary(markdown) {
  if (!SUMMARY_FILE) return
  try {
    fs.appendFileSync(SUMMARY_FILE, markdown + '\n')
    // 验证写入成功
    const size = fs.statSync(SUMMARY_FILE).size
    if (size > 0) {
      console.log(`[Summary] 已追加 ${Buffer.byteLength(markdown)} 字节，总计 ${size} 字节`)
    }
  } catch (err) {
    console.warn(`[Summary] 写入失败：${err.message}`)
  }
}

/**
 * 生成并展示单个二维码 — 三重展示渠道确保用户一定能扫到：
 *
 *   ① 自包含 HTML 页面（qr/login.html）：浏览器打开即见大图，手机直接扫
 *      ← 最可靠，不依赖任何平台限制，artifact 立即可下载
 *   ② Step Summary 摘要页：<img> data URI 图片，在 Actions Summary 标签页查看
 *   ③ PNG 文件（qr/qr-N.png）：高清原图，artifact 下载备用
 *
 * @param {string} url   酷狗扫码登录完整 URL
 * @param {number} index 账号序号（从 1 开始）
 * @param {number} total 总账号数
 * @returns {{ dataUrl: string, url: string }} 供 HTML 聚合用
 */
async function buildQr(url, index, total) {
  const header = total > 1 ? `（第 ${index}/${total} 个账号）` : ''

  fs.mkdirSync(QR_DIR, { recursive: true })

  // ── 1) PNG 文件（artifact 下载 + HTML 内嵌双用途）──
  await QRCode.toFile(`${QR_DIR}/qr-${index}.png`, url, { width: 320, margin: 2 })

  // ── 2) base64 data URI（Summary <img> + HTML <img> 共用）──
  const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 })
  const pngBase64 = dataUrl.replace(/^data:image\/png;base64,/, '')

  // ── 3) 日志输出：指引去直链步骤 ──
  printMagenta(`\n═══ 第 ${index}/${total} 个二维码已生成 ═══`)
  console.log('')
  console.log('  🔗 请查看下一步「发布二维码图片直链」输出的链接，浏览器打开即可直接扫码')
  console.log('')

  return { dataUrl, url, header, index }
}

/**
 * 生成自包含 HTML 登录页（所有二维码的大图集中展示）
 * 用户从 artifact 下载后双击/手机打开即可直接扫码，无需任何依赖。
 */
function generateHtmlPage(qrItems) {
  const cards = qrItems.map(item => `
    <div class="card">
      <h2>账号 ${item.index}/${qrItems.length} ${item.header}</h2>
      <div class="qrcode">
        <img src="${item.dataUrl}" alt="账号${item.index} 二维码" />
      </div>
      <p class="url"><code>${item.url}</code></p>
      <p class="tip">⏳ 有效期约 2 分钟</p>
    </div>
  `).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>酷狗音乐扫码登录</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  background:#0d1117;color:#e6edf3;display:flex;flex-direction:column;
  align-items:center;min-height:100vh;padding:20px;
}
.header{text-align:center;margin-bottom:30px}
.header h1{font-size:24px;color:#58a6ff}
.header p{color:#8b949e;font-size:14px;margin-top:8px}
.cards{display:flex;flex-wrap:wrap;justify-content:center;gap:24px;width:100%;max-width:960px}
.card{
  background:#161b22;border:1px solid #30363d;border-radius:16px;
  padding:28px 20px;text-align:center;width:320px;
}
.card h2{font-size:16px;color:#e6edf3;margin-bottom:16px}
.qrcode img{
  width:280px;height:auto;border-radius:12px;
  border:3px solid #30363d;background:#fff;padding:12px;
}
.url{margin-top:14px;word-break:break-all;font-size:13px;color:#8b949e}
.tip{margin-top:8px;color:#f0883e;font-size:13px;font-weight:600}
.footer{margin-top:40px;color:#484f58;font-size:12px}
@media(max-width:400px){
  .card{width:100%;padding:20px 12px}
  .qrcode img{width:240px}
}
</style>
</head>
<body>
<div class="header">
  <h1>🎵 酷狗音乐扫码登录</h1>
  <p>使用「酷狗音乐 APP」扫描下方二维码完成登录</p>
</div>
<div class="cards">${cards}</div>
<p class="footer">此页面由 kgcheckin 自动生成 · 二维码有效期约 2 分钟 · 请尽快扫描</p>
</body>
</html>`
}

/** 解析账号数量 */
function resolveNumber() {
  const args = process.argv.slice(3)
  return parseInt(process.env.NUMBER || args[0] || "1")
}

/**
 * 模式一：生成二维码（PNG + Summary + HTML），随后立即结束 step。
 * step 结束后 artifact 即可下载 HTML 页面（含大图），用户浏览器打开直接扫码。
 */
async function genMode() {
  const api = startService()
  await delay(2000)
  const USERINFO = process.env.USERINFO
  const APPEND_USER = process.env.APPEND_USER
  const userinfo = (USERINFO && APPEND_USER == "是") ? JSON.parse(USERINFO) : []
  const number = resolveNumber()
  const keys = []

  if (!SUMMARY_FILE) {
    console.log('[INFO] 非 Actions 环境（$GITHUB_STEP_SUMMARY 未设置），Summary 将跳过')
  }

  try {
    const qrItems = [] // 收集所有二维码信息用于生成聚合 HTML

    for (let n = 0; n < number; n++) {
      const result = await send(`/login/qr/key?timestrap=${Date.now()}`, "GET", {})
      if (result.status === 1) {
        const qrcode = result.data.qrcode
        const qrUrl = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${qrcode}`
        keys.push(qrcode)
        const item = await buildQr(qrUrl, n + 1, number)
        qrItems.push(item)
      } else {
        printRed("响应内容")
        console.dir(summarizeResponse(result), { depth: null })
        throw new Error(`获取二维码密钥失败：接口返回 status=${result.status}`)
      }
    }

    // ── 生成自包含 HTML 登录页（核心展示渠道！）──
    if (qrItems.length > 0) {
      const htmlContent = generateHtmlPage(qrItems)
      fs.writeFileSync(`${QR_DIR}/login.html`, htmlContent, 'utf8')

      // 也把每个二维码单独做成一个 HTML 方便多账号时逐个处理
      for (const item of qrItems) {
        fs.writeFileSync(
          `${QR_DIR}/qr-${item.index}.html`,
          `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>扫码登录 ${item.header}</title>` +
          `<style>*{margin:0;padding:0}body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:#0d1117}` +
          `img{border-radius:16px;border:3px solid #30363d;padding:20px;background:#fff;max-width:90vw}</style></head>` +
          `<body><img src="${item.dataUrl}" alt="扫码登录${item.header}" /></body></html>`,
          'utf8'
        )
      }
    }

    fs.writeFileSync(KEYS_FILE, JSON.stringify({ number, keys }))
    printMagenta(`\n✅ 已生成 ${number} 个二维码。`)
    printMagenta(`🔗 请查看下一步「发布二维码图片直链」输出的可点击链接，浏览器打开即可直接扫码！`)
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    console.error(`::error::二维码生成失败：${msg}`)
    throw e
  } finally {
    // 强制关闭 API 服务（加超时防止挂死）
    await Promise.race([
      close_api(api),
      new Promise(r => setTimeout(r, 3000))
    ])
  }
}

/**
 * 模式二：读取已生成的二维码密钥，轮询等待用户扫码确认
 */
async function waitMode() {
  const api = startService()
  await delay(2000)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'))
  } catch {
    throw new Error('未找到二维码密钥文件，请确认已先运行「生成登录二维码图片」步骤')
  }
  const { number, keys } = parsed
  const USERINFO = process.env.USERINFO
  const APPEND_USER = process.env.APPEND_USER
  const userinfo = (USERINFO && APPEND_USER == "是") ? JSON.parse(USERINFO) : []

  try {
    for (let n = 0; n < number; n++) {
      const qrcode = keys[n]
      printMagenta(`\n正在等待第 ${n + 1}/${number} 个账号扫码登录...`)
      let loggedIn = false
      for (let i = 0; i < 30; i++) {
        const timestrap = Date.now();
        const res = await send(`/login/qr/check?key=${qrcode}&timestrap=${timestrap}`, "GET", {})
        const status = res?.data?.status
        switch (status) {
          case 0:
            printYellow("二维码已过期，请重新运行工作流生成新二维码")
            break
          case 1:
            // 未扫描二维码
            break
          case 2:
            // 二维码未确认，请点击确认登录
            break
          case 4:
            printGreen("登录成功！")
            upsertUser(userinfo, { userid: res.data.userid, token: res.data.token }, APPEND_USER == "是")
            loggedIn = true
            break
          default:
            printRed("请求出错")
            console.dir(summarizeResponse(res), { depth: null })
        }
        if (loggedIn || status == 0) {
          break
        }
        if (i == 29) {
          printRed("等待超时\n")
        }
        await delay(5000)
      }
    }
    saveUserinfo(userinfo)
  } finally {
    await Promise.race([
      close_api(api),
      new Promise(r => setTimeout(r, 3000))
    ])
  }
}

const mode = process.argv[2] || 'gen'
if (mode === 'wait') {
  waitMode().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
} else {
  genMode().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
