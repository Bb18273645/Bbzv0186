#!/usr/bin/env python3
# apply_deleted_tweets.py — 应用 accounts/*/.deleted_tweets.txt 删除清单
# 用法: python3 apply_deleted_tweets.py [cdx|full]   (默认 full)
#   cdx   : 仅清理 cdx_data.json/.bak 中清单推文的记录（fetch-cdx 之后跑，防止重新下载）
#   full  : cdx + index.json 条目 + html/json 快照文件（build-index 之后跑，最终强制清理）
import json, glob, os, re, sys

MODE = sys.argv[1] if len(sys.argv) > 1 else 'full'


def load_tids(acct):
    lst = os.path.join(acct, '.deleted_tweets.txt')
    if not os.path.exists(lst):
        return None
    tids = set()
    for line in open(lst, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        tids.add(line.split()[0])
    return tids


def clean_cdx(acct, tids):
    for cp in glob.glob(os.path.join(acct, 'cdx_data.json*')):
        try:
            d = json.load(open(cp, encoding='utf-8'))
            if isinstance(d, list) and len(d) > 1:
                n = [d[0]] + [r for r in d[1:] if not any(('/status/' + t) in json.dumps(r) for t in tids)]
                if len(n) != len(d):
                    open(cp, 'w', encoding='utf-8').write(json.dumps(n, ensure_ascii=False, separators=(',', ':')))
                    print('cdx:', os.path.basename(cp), len(d), '->', len(n))
        except Exception as e:
            print('跳过', cp, repr(e))


total = 0
for acct in sorted(glob.glob('accounts/*')):
    if not os.path.isdir(acct):
        continue
    tids = load_tids(acct)
    if not tids:
        continue
    snap = os.path.join(acct, 'wayback_snapshots')
    clean_cdx(acct, tids)
    if MODE == 'cdx':
        continue
    # index.json 移除条目
    ip = os.path.join(snap, 'index.json')
    if os.path.exists(ip):
        d = json.load(open(ip, encoding='utf-8'))
        n = [e for e in d if str(e.get('tweet_id', '')) not in tids]
        if len(n) != len(d):
            open(ip, 'w', encoding='utf-8').write(json.dumps(n, ensure_ascii=False, separators=(',', ':')))
            print(acct, 'index.json:', len(d), '->', len(n))
            total += len(d) - len(n)
    # html/json 快照文件
    for sub in ('html', 'json'):
        for f in glob.glob(os.path.join(snap, sub, '*')):
            m = re.search(r'status_(\d+)', os.path.basename(f))
            if m and m.group(1) in tids:
                os.remove(f)
                print('删除文件:', os.path.relpath(f))

print('共清理条目:', total)
