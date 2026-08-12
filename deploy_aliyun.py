# -*- coding: utf-8 -*-
# 阿里云 FC 全自动部署脚本（真账号体系版）
# 用主账号 AK 建/更新 FC 服务+函数+HTTP触发器；存储用阿里云OSS（深圳）。
# 安全改进：FC 服务配置 RAM 角色(临时凭证)，函数通过服务角色访问 OSS，不再把主账号 AK 注入函数环境变量。
# 打包目录：本仓库的 fc-backend/（含 index.js 与 node_modules/ali-oss）
import os, sys, io, zipfile, base64, json, subprocess, secrets
from pathlib import Path

def log(*a): print('[deploy]', *a, flush=True)

AK_ID = os.environ.get('ALI_AK_ID')
AK_SECRET = os.environ.get('ALI_AK_SECRET')
if not AK_ID or not AK_SECRET:
    sys.exit('缺少 ALI_AK_ID / ALI_AK_SECRET 环境变量')

REGION = 'cn-shenzhen'
SERVICE = 'cb-ration-sync'
FUNCTION = 'cb-ration-sync'
PKG_DIR = Path('fc-backend').resolve()

OSS_BUCKET = 'cb-ration-wg-sync'
OSS_REGION = 'oss-cn-shenzhen'
SALT = 'wg-grid-sync-v1-fixed-salt-do-not-leak'

ADMIN_PASS = os.environ.get('CB_ADMIN_PASS') or '39KfI2PSovmRx97mSw6Z'

# 真账号体系的服务端签名密钥：优先取环境变量 CB_AUTH_SECRET；否则首次随机生成并落盘 .auth_secret，重部署复用（避免已签发 token 失效）
AUTH_SECRET = os.environ.get('CB_AUTH_SECRET')
if not AUTH_SECRET:
    secret_file = Path('.auth_secret')
    if secret_file.exists():
        AUTH_SECRET = secret_file.read_text().strip() or secrets.token_urlsafe(32)
    else:
        AUTH_SECRET = secrets.token_urlsafe(32)
    try:
        secret_file.write_text(AUTH_SECRET)
    except Exception:
        pass
    log('使用本地 .auth_secret 作为 AUTH_SECRET（重置请删除该文件后重部署）')

# ---- 1. 打包 ----
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in PKG_DIR.iterdir():
        if f.is_file():
            z.write(f, f.name)
        elif f.name == 'node_modules':
            for root, _, files in os.walk(f):
                for fn in files:
                    fp = Path(root) / fn
                    z.write(fp, fp.relative_to(PKG_DIR))
zipb64 = base64.b64encode(buf.getvalue()).decode()
log('打包完成, 大小 %.2f MB' % (len(zipb64) / 1024 / 1024))

# ---- 2. FC client ----
from alibabacloud_fc_open20210406.client import Client as FCClient
from alibabacloud_fc_open20210406 import models as fc_models
from alibabacloud_tea_openapi import models as open_api_models

config = open_api_models.Config(access_key_id=AK_ID, access_key_secret=AK_SECRET)
config.endpoint = 'fc.%s.aliyuncs.com' % REGION
config.read_timeout = 120000
config.connect_timeout = 30000
client = FCClient(config)

# ---- 3. 创建/复用 RAM 角色（服务角色访问 OSS），从响应直接拿 ARN，不依赖主账号 UID ----
ROLE_NAME = 'cb-ration-fc-role'
POLICY_NAME = 'cb-ration-oss-rw'
role_arn = None
try:
    from alibabacloud_ram20150501.client import Client as RAMClient
    from alibabacloud_ram20150501 import models as ram_models
    ram_config = open_api_models.Config(access_key_id=AK_ID, access_key_secret=AK_SECRET)
    ram_config.endpoint = 'ram.aliyuncs.com'
    ram_client = RAMClient(ram_config)

    trust = json.dumps({
        "Statement": [{"Action": "sts:AssumeRole", "Effect": "Allow",
                      "Principal": {"Service": ["fc.aliyuncs.com"]}}],
        "Version": "1"
    })
    try:
        resp = ram_client.create_role(ram_models.CreateRoleRequest(
            role_name=ROLE_NAME, assume_role_policy_document=trust,
            description='cb-ration FC sync role for OSS'))
        role_arn = getattr(resp.body, 'arn', None) or getattr(getattr(resp.body, 'role', None), 'arn', None)
        log('RAM 角色已创建: %s' % ROLE_NAME)
    except Exception as e:
        if 'AlreadyExist' in str(e) or 'exists' in str(e).lower():
            try:
                gr = ram_client.get_role(ram_models.GetRoleRequest(role_name=ROLE_NAME))
                role_arn = getattr(gr.body, 'arn', None) or getattr(getattr(gr.body, 'role', None), 'arn', None)
                log('RAM 角色已存在，ARN 已获取')
            except Exception as e2:
                log('GetRole 失败(继续): %s' % e2)
        else:
            raise

    policy = json.dumps({
        "Version": "1",
        "Statement": [{
            "Effect": "Allow",
            "Action": ["oss:GetObject", "oss:PutObject", "oss:DeleteObject",
                       "oss:ListObjects", "oss:HeadObject"],
            "Resource": ["acs:oss:*:*:cb-ration-wg-sync",
                         "acs:oss:*:*:cb-ration-wg-sync/*"]
        }]
    })
    try:
        ram_client.create_policy(ram_models.CreatePolicyRequest(
            policy_name=POLICY_NAME, policy_document=policy,
            description='cb-ration OSS read/write'))
        log('RAM 策略已创建: %s' % POLICY_NAME)
    except Exception as e:
        if 'AlreadyExist' in str(e) or 'exists' in str(e).lower():
            log('RAM 策略已存在，跳过')
        else:
            raise

    try:
        ram_client.attach_policy_to_role(ram_models.AttachPolicyToRoleRequest(
            policy_name=POLICY_NAME, policy_type='Custom', role_name=ROLE_NAME))
        log('策略已附加到角色')
    except Exception as e:
        if 'Exist' in str(e) or 'attached' in str(e).lower() or 'exists' in str(e).lower():
            log('策略已附加，跳过')
        else:
            log('附加策略警告(继续): %s' % e)

    log('角色 ARN: %s' % role_arn)
except Exception as e:
    log('RAM 角色配置失败(函数将退回使用环境变量 AK): %s' % e)

# ---- 4. 建服务（幂等），并配置服务角色（函数继承服务角色获取临时凭证）----
try:
    client.create_service(fc_models.CreateServiceRequest(service_name=SERVICE, role=role_arn))
    log('服务已创建: %s' % SERVICE)
except Exception as e:
    if 'exist' in str(e).lower() or 'AlreadyExist' in str(e):
        try:
            client.update_service(SERVICE, fc_models.UpdateServiceRequest(role=role_arn))
            log('服务已存在，已更新角色配置')
        except Exception as e2:
            log('更新服务角色失败(继续): %s' % e2)
    else:
        log('创建服务异常(继续): %s' % e)

# ---- 5. 覆盖式部署：先删触发器 → 再删函数 → 再重建 ----
trigger_name = 'httpTrigger'
try:
    client.delete_trigger(SERVICE, FUNCTION, trigger_name)
    log('已删旧触发器')
except Exception:
    pass

try:
    client.delete_function(SERVICE, FUNCTION)
    log('已删除旧函数')
except Exception as e:
    log('删除旧函数(忽略): %s' % e)

# 优先用 RAM 服务角色访问 OSS（role_arn 非空时不再注入主账号 AK）
env_vars = {
    'OSS_BUCKET': OSS_BUCKET, 'OSS_REGION': OSS_REGION, 'SALT': SALT,
    'ADMIN_PASS': ADMIN_PASS, 'AUTH_SECRET': AUTH_SECRET
}
if not role_arn:
    env_vars['OSS_AK_ID'] = AK_ID
    env_vars['OSS_AK_SECRET'] = AK_SECRET
    log('未配置 RAM 角色，函数回退使用主账号 AK（建议修复）')

create_req = fc_models.CreateFunctionRequest(
    function_name=FUNCTION,
    runtime='nodejs16',
    handler='index.handler',
    memory_size=128,
    timeout=30,
    description='cb-ration cloud sync backend (real auth)',
    environment_variables=env_vars,
    code=fc_models.Code(zip_file=zipb64)
)
try:
    client.create_function(SERVICE, create_req)
    log('函数已创建: %s' % FUNCTION)
except Exception as e:
    if 'AlreadyExist' in str(e):
        log('函数已存在，改用 update_function 覆盖代码与配置')
        update_req = fc_models.UpdateFunctionRequest(
            runtime='nodejs16',
            handler='index.handler',
            memory_size=128,
            timeout=30,
            description='cb-ration cloud sync backend (real auth)',
            environment_variables=env_vars,
            code=fc_models.Code(zip_file=zipb64)
        )
        client.update_function(SERVICE, FUNCTION, update_req)
        log('函数已更新(覆盖): %s' % FUNCTION)
    else:
        log('创建函数失败: %s' % e)
        sys.exit(1)

# ---- 6. 建 HTTP 触发器（免鉴权，幂等）----
trig = fc_models.CreateTriggerRequest(
    trigger_name=trigger_name,
    trigger_type='http',
    trigger_config='{"authType":"anonymous","methods":["GET","POST","OPTIONS"]}',
    qualifier='LATEST',
    invocation_role=''
)
try:
    client.create_trigger(SERVICE, FUNCTION, trig)
    log('HTTP 触发器已创建')
except Exception as e:
    if 'exist' in str(e).lower() or 'AlreadyExist' in str(e):
        log('触发器已存在，跳过')
    else:
        log('创建触发器失败: %s' % e)

# ---- 7. 收尾（前端用固定 *.fcapp.run 地址，fc_url.txt 留空无碍）----
Path('fc_url.txt').write_text('', encoding='utf-8')
Path('admin_pass.txt').write_text('云端版管理员密码(请妥善保管，勿外泄):\n' + ADMIN_PASS + '\n', encoding='utf-8')
log('管理员密码已写入 admin_pass.txt')
print('FC_ROLE_ARN=' + str(role_arn))
