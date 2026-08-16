#!/usr/bin/env python3
# apply_profile_override.py — 应用 accounts/*/profile_override.json 手动简介覆盖
# 用法: python3 apply_profile_override.py
# 在 build-index 之后运行：build-index 会用最新快照刷新 profile.json（覆盖手动 bio），
# 本脚本把 override 文件里非空字段（如 bio）重新写回，保证手动简介不被每日增量冲掉。
# 说明：覆盖了 bio 时同步清空 bio_entities（手动 bio 直接是最终文本，无需 entities）。
import json, glob, os

for acct in sorted(glob.glob('accounts/*')):
    if not os.path.isdir(acct):
        continue
    ov_path = os.path.join(acct, 'profile_override.json')
    if not os.path.exists(ov_path):
        continue
    try:
        ov = json.load(open(ov_path, encoding='utf-8'))
    except Exception as e:
        print('跳过', ov_path, repr(e))
        continue
    prof_path = os.path.join(acct, 'wayback_snapshots', 'profile.json')
    if not os.path.exists(prof_path):
        continue
    try:
        prof = json.load(open(prof_path, encoding='utf-8'))
    except Exception as e:
        print('跳过', prof_path, repr(e))
        continue
    changed = []
    for k, v in ov.items():
        if v and prof.get(k) != v:
            prof[k] = v
            changed.append(k)
    if 'bio' in ov:
        if prof.get('bio_entities'):
            prof['bio_entities'] = {}
            changed.append('bio_entities')
    if changed:
        with open(prof_path, 'w', encoding='utf-8') as f:
            json.dump(prof, f, ensure_ascii=False, indent=2)
        print(acct, 'profile.json 已覆盖:', ', '.join(changed))
