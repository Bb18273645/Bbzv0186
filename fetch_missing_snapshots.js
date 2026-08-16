// fetch_missing_snapshots.js
// 补抓缺失的 Wayback Machine 快照（HTML / 图片 / 头像）
// 用法:
//   node fetch_missing_snapshots.js            # 补抓默认账号 Bbzv0186
//   node fetch_missing_snapshots.js <账号名>    # 指定账号
//   node fetch_missing_snapshots.js --dry-run   # 只列出缺失清单，不下载
//   node fetch_missing_snapshots.js --help      # 显示帮助
// 依赖: Node.js 18+（自带全局 fetch），需要能访问 web.archive.org

const fs = require('fs');
const path = require('path');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`用法:
  node fetch_missing_snapshots.js [--dry-run] [<账号名>]

  --dry-run   只列出缺失清单，不下载
  <账号名>     指定账号（默认 Bbzv0186）`);
  process.exit(0);
}

const DRY_RUN = process.argv.includes('--dry-run');
const ARGS = process.argv.slice(2).filter(a => !a.startsWith('-'));
const ACCOUNT = ARGS[0] || 'Bbzv0186';
const ROOT = __dirname;
const BASE = path.join(ROOT, 'accounts', ACCOUNT, 'wayback_snapshots');
const INDEX = path.join(BASE, 'index.json');
const LOG_INDEX = path.join(BASE, '_log', 'archive_index.json');
const WB = 'https://web.archive.org';

// index.json 里的 file 字段不可信：只取 basename，杜绝 ../ 写出目录
const safeBasename = (p) => path.basename(p || '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wget(url, { retries = 2, timeout = 30000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeout) });
      if (res.status >= 400) throw new Error('HTTP ' + res.status + ' for ' + url);
      return { buf: Buffer.from(await res.arrayBuffer()), finalUrl: res.url };
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

function tsFromFile(file) {
  const m = /^(\d{14})_/.exec(file || '');
  return m ? m[1] : null;
}

// 20260729150602_pbs.twimg.com_media_HOZR19PaYAAmYZn.jpg -> pbs.twimg.com/media/HOZR19PaYAAmYZn.jpg
function imageKeyFromName(name) {
  const m = /^\d{14}_(.+)$/.exec(name);
  return m ? m[1].replace(/_/g, '/') : name;
}

function wbUrlForKey(key, ts) {
  const withoutProto = key.replace(/^https?:\/\//, '');
  const p = /\.(jpg|jpeg|png|gif|webp|mp4|webm)(\?.*)?$/i.test(withoutProto) ? withoutProto : withoutProto + '.jpg';
  return ts ? `${WB}/web/${ts}if_/https://${p}` : `https://${p}`;
}

async function main() {
  if (!fs.existsSync(INDEX)) {
    console.error('找不到 index.json: ' + INDEX);
    process.exit(1);
  }
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const htmlDir = path.join(BASE, 'html');
  const imageDir = path.join(BASE, 'image');
  const avatarDir = path.join(BASE, 'avatar');
  for (const d of [htmlDir, imageDir, avatarDir]) fs.mkdirSync(d, { recursive: true });

  const missingHtml = [];
  const missingImages = new Map();
  const missingAvatars = new Map();

  const addMissingImage = (ref) => {
    const name = path.basename(ref);
    if (!name || fs.existsSync(path.join(imageDir, name))) return;
    if (!missingImages.has(name)) missingImages.set(name, { name, key: imageKeyFromName(name) });
  };
  const addMissingAvatar = (ref) => {
    const name = path.basename(ref);
    const m = /^avatar_(\d+)\.(\w+)$/.exec(name);
    if (!m || fs.existsSync(path.join(avatarDir, name))) return;
    if (!missingAvatars.has(name)) missingAvatars.set(name, { name, id: m[1] });
  };

  for (const it of idx) {
    if (it.is_virtual) continue;
    const file = safeBasename(it.file);
    const ts = tsFromFile(file);
    if (file && !fs.existsSync(path.join(htmlDir, file))) {
      missingHtml.push({ item: it, file, ts });
    }
    for (const ref of [...(it.embedded_images || []), ...(it.wanted_images || []),
                       ...(it.embedded_videos || []), ...(it.wanted_videos || [])]) addMissingImage(ref);
    for (const ref of it.wanted_avatars || []) addMissingAvatar(ref);
  }

  console.log('=== 缺失清单 ===');
  console.log('HTML: ' + missingHtml.length);
  for (const h of missingHtml) console.log('  ', h.item.tweet_id, h.file);
  console.log('图片: ' + missingImages.size);
  for (const [n] of missingImages) console.log('  ', n);
  console.log('头像: ' + missingAvatars.size);
  for (const [n] of missingAvatars) console.log('  ', n);
  if (DRY_RUN) { console.log('\n(--dry-run，未下载)'); return; }

  // --- 下载 HTML ---
  let htmlOk = 0;
  for (const { item, file, ts } of missingHtml) {
    const id = item.tweet_id;
    const url = `${WB}/web/${ts}if_/https://twitter.com/${ACCOUNT}/status/${id}`;
    console.log('\n[HTML] ' + id);
    try {
      const { buf } = await wget(url);
      let html = buf.toString('utf8');
      html = html.replace(/<div[^>]*id="jsonview"[^>]*>[\s\S]*?<\/div>/i, '');
      html = html.replace(/<div[^>]*class="notice"[^>]*>[\s\S]*?<\/div>/i, '');
      html = html.replace(/<div[^>]*id="wm-ipp[^"]*"[^>]*>[\s\S]*?<\/div>/i, '');
      html = html.replace(new RegExp('https://web\\.archive\\.org/web/\\d+if_/(?:https?://)?(pbs\\.twimg\\.com/media/[^"\'\\s)+]+)', 'g'), (m, key) => {
        const name = ts + '_' + key.replace(/\//g, '_');
        return '../image/' + name;
      });
      html = html.replace(new RegExp('https://web\\.archive\\.org/web/\\d+if_/(?:https?://)?pbs\\.twimg\\.com/profile_images/(\\d+)/([^"\'\\s)+]+)', 'g'), (m, uid) => {
        return '../avatar/avatar_' + uid + '.jpg';
      });
      if (!html.startsWith('<!-- Source:')) {
        html = `<!-- Source: ${WB}/web/${ts}if_/twitter_com_${ACCOUNT}_status_${id} -->\n` + html;
      }
      fs.writeFileSync(path.join(htmlDir, file), html);
      htmlOk++;
      console.log('  -> 已保存 ' + file + ' (' + html.length + ' bytes)');
    } catch (e) {
      console.error('  !! 下载失败: ' + e.message);
    }
    await sleep(800);
  }

  // --- 下载图片 ---
  let imgOk = 0;
  for (const [name, info] of missingImages) {
    if (fs.existsSync(path.join(imageDir, name))) continue;
    console.log('\n[IMG] ' + name);
    try {
      let resp;
      try {
        resp = await wget(wbUrlForKey(info.key, '')); // 直连 pbs.twimg.com
      } catch (e) {
        resp = await wget(`${WB}/web/0/https://${info.key}`); // fallback: wayback 最早快照
      }
      const { buf, finalUrl } = resp;
      const ext = (path.extname(finalUrl) || path.extname(name) || '.jpg').toLowerCase();
      const finalName = ext === '.jpg' ? name : name.replace(/\.\w+$/, ext);
      fs.writeFileSync(path.join(imageDir, finalName), buf);
      imgOk++;
      console.log('  -> 已保存 ' + finalName + ' (' + buf.length + ' bytes)');
    } catch (e) {
      console.error('  !! 下载失败: ' + e.message);
    }
    await sleep(500);
  }

  // --- 下载头像 ---
  // 先把 html/ 目录列表读一次，避免每个缺失头像都重复扫目录
  const htmlFiles = fs.readdirSync(htmlDir).filter(f => f.endsWith('.html'));
  let avOk = 0;
  for (const [name, info] of missingAvatars) {
    if (fs.existsSync(path.join(avatarDir, name))) continue;
    console.log('\n[AVATAR] ' + name);
    let done = false;
    for (const f of htmlFiles) {
      const html = fs.readFileSync(path.join(htmlDir, f), 'utf8');
      const re = new RegExp('profile_images/' + info.id + "/([^\"'\\s)+]+)", 'g');
      let m;
      while ((m = re.exec(html)) && !done) {
        const cand = 'https://pbs.twimg.com/profile_images/' + info.id + '/' + m[1];
        try {
          const { buf } = await wget(cand);
          fs.writeFileSync(path.join(avatarDir, name), buf);
          avOk++;
          done = true;
          console.log('  -> 已保存 ' + name + ' (' + buf.length + ' bytes)');
        } catch (e) { /* try next */ }
      }
      if (done) break;
    }
    if (!done) console.error('  !! 未能获取（HTML 中无该头像引用，需手动补）');
    await sleep(500);
  }

  // --- 更新 archive_index.json ---
  try {
    if (fs.existsSync(LOG_INDEX)) {
      const log = JSON.parse(fs.readFileSync(LOG_INDEX, 'utf8'));
      if (log && typeof log === 'object') {
        log.last_updated = new Date().toISOString();
        fs.writeFileSync(LOG_INDEX, JSON.stringify(log, null, 2), 'utf8');
      }
    }
  } catch (e) {
    console.warn('更新 archive_index.json 失败: ' + e.message);
  }

  console.log('\n=== 完成 ===');
  console.log('HTML 成功: ' + htmlOk + '/' + missingHtml.length);
  console.log('图片成功: ' + imgOk + '/' + missingImages.size);
  console.log('头像成功: ' + avOk + '/' + missingAvatars.size);
}

main().catch((e) => { console.error(e); process.exit(1); });
