# -*- coding: utf-8 -*-
# 阿里云 FC 部署脚本：把「审核进度抓取」搬到境内节点，根治境外 IP 导致 progress_dt 冻结。
#
# 用法：
#   set ALI_AK_ID=xxx
#   set ALI_AK_SECRET=xxx
#   set GH_TOKEN=github_pat_xxx        (需 contents:write + actions:write 权限)
#   python deploy_fc_fetch.py
#
# 说明：
#   - 服务 cb-ration-fetch 建在 cn-hangzhou（境内 IP，集思录进度日期正常）
#   - 函数 fetch-progress 用 Python3.9 runtime，零第三方依赖（纯标准库）
#   - 定时触发器每小时触发一次，函数内部再用 in_fetch_window() 判断是否真正抓取
#   - 函数只抓集思录 + 推送 GitHub，不依赖 OSS，故无需 RAM 角色
import os, sys, io, zipfile, base64
from pathlib import Path

def log(*a): print('[deploy]', *a, flush=True)

AK_ID = os.environ.get('ALI_AK_ID')
AK_SECRET = os.environ.get('ALI_AK_SECRET')
GH_TOKEN = os.environ.get('GH_TOKEN')
if not AK_ID or not AK_SECRET:
    sys.exit('缺少 ALI_AK_ID / ALI_AK_SECRET 环境变量')
if not GH_TOKEN:
    sys.exit('缺少 GH_TOKEN 环境变量（需 contents:write + actions:write 权限）')

REGION = 'cn-hangzhou'          # 杭州境内节点（关键：根治境外冻结）
SERVICE = 'cb-ration-fetch'
FUNCTION = 'fetch-progress'
PKG_DIR = Path(__file__).resolve().parent   # 本目录即函数代码（index.py）
GH_REPO = os.environ.get('GH_REPO', 'xianmeng872/cb-ration')
GH_BRANCH = os.environ.get('GH_BRANCH', 'main')

# ---- 1. 打包（仅 index.py，纯标准库；部署脚本本身不进函数包）----
buf = io.BytesIO()
idx = PKG_DIR / 'index.py'
if not idx.exists():
    sys.exit('找不到 index.py')
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    z.write(idx, 'index.py')
zipb64 = base64.b64encode(buf.getvalue()).decode()
log('打包完成, 大小 %.2f KB' % (len(zipb64) / 1024))

# ---- 2. FC client ----
try:
    from alibabacloud_fc_open20210406.client import Client as FCClient
    from alibabacloud_fc_open20210406 import models as fc_models
    from alibabacloud_tea_openapi import models as open_api_models
except ImportError:
    sys.exit('缺少 FC SDK，请先安装：pip install alibabacloud_fc_open20210406 alibabacloud_tea_openapi')

config = open_api_models.Config(access_key_id=AK_ID, access_key_secret=AK_SECRET)
config.endpoint = 'fc.%s.aliyuncs.com' % REGION
config.read_timeout = 120000
config.connect_timeout = 30000
client = FCClient(config)

# ---- 3. 服务（幂等）----
try:
    client.create_service(fc_models.CreateServiceRequest(service_name=SERVICE))
    log('服务已创建: %s' % SERVICE)
except Exception as e:
    if 'exist' in str(e).lower() or 'AlreadyExist' in str(e):
        log('服务已存在，跳过创建')
    else:
        raise

# ---- 4. 函数（覆盖式）----
env_vars = {
    'GH_TOKEN': GH_TOKEN,
    'GH_REPO': GH_REPO,
    'GH_BRANCH': GH_BRANCH,
    'DRY_RUN': '0',
    'TZ': 'Asia/Shanghai',
}
create_req = fc_models.CreateFunctionRequest(
    function_name=FUNCTION,
    runtime='python3.9',
    handler='index.handler',
    memory_size=256,
    timeout=120,
    description='审核进度抓取(境内FC，根治境外IP进度冻结)',
    environment_variables=env_vars,
    code=fc_models.Code(zip_file=zipb64)
)
try:
    client.create_function(SERVICE, create_req)
    log('函数已创建: %s' % FUNCTION)
except Exception as e:
    if 'AlreadyExist' in str(e):
        update_req = fc_models.UpdateFunctionRequest(
            runtime='python3.9',
            handler='index.handler',
            memory_size=256,
            timeout=120,
            description='审核进度抓取(境内FC，根治境外IP进度冻结)',
            environment_variables=env_vars,
            code=fc_models.Code(zip_file=zipb64)
        )
        client.update_function(SERVICE, FUNCTION, update_req)
        log('函数已更新(覆盖): %s' % FUNCTION)
    else:
        log('创建函数失败: %s' % e)
        sys.exit(1)

# ---- 5. 定时触发器（每小时触发，函数内判断窗口）----
# FC timer cron 为 UTC；每小时第 0 分触发（北京每小时整点）。
# 函数内部用 in_fetch_window() 在「早05-10 / 晚21-24」才真正抓取，避免空跑。
trigger_name = 'timerTrigger'
try:
    client.delete_trigger(SERVICE, FUNCTION, trigger_name)
    log('已删旧定时器')
except Exception:
    pass
trig = fc_models.CreateTriggerRequest(
    trigger_name=trigger_name,
    trigger_type='timer',
    trigger_config='{"payload":"","cronExpression":"0 0 * * * *","enable":true}',
    qualifier='LATEST',
    invocation_role=''
)
try:
    client.create_trigger(SERVICE, FUNCTION, trig)
    log('定时触发器已创建（每小时一次）')
except Exception as e:
    if 'exist' in str(e).lower() or 'AlreadyExist' in str(e):
        log('定时器已存在，跳过')
    else:
        log('创建定时器失败(可手动在控制台加): %s' % e)

log('部署完成。服务 %s / 函数 %s @ %s' % (SERVICE, FUNCTION, REGION))
