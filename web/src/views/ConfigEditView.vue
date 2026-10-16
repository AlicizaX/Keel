<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import KvEditor from '../components/KvEditor.vue';
import ActionsEditor from '../components/ActionsEditor.vue';

const route = useRoute();
const router = useRouter();
const configId = route.params.id as string | undefined;
const isNew = !configId;

const TARGETS = ['Windows', 'macOS', 'Linux', 'Android', 'iOS', 'WebGL'];
const installations = ref<any[]>([]);
const agents = ref<any[]>([]);
const project = ref<any>(null);
const saving = ref(false);
const error = ref('');
const triggerToken = ref('');
const triggerCopied = ref(false);

const triggerUrl = computed(() =>
  triggerToken.value ? `${location.origin}/api/hooks/trigger/${triggerToken.value}` : '',
);

async function loadTrigger() {
  if (isNew) return;
  const r = await api.get(`/configs/${configId}/trigger`);
  triggerToken.value = r.token ?? '';
}

async function rotateTrigger() {
  if (triggerToken.value && !confirm('重置后旧触发链接立即失效，确定继续？')) return;
  const r = await api.post(`/configs/${configId}/trigger`);
  triggerToken.value = r.token;
}

async function copyTrigger() {
  try {
    await navigator.clipboard.writeText(triggerUrl.value);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = triggerUrl.value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  triggerCopied.value = true;
  setTimeout(() => (triggerCopied.value = false), 1500);
}

const form = ref<any>({
  project_id: (route.query.projectId as string) ?? '',
  name: '',
  build_target: 'Windows',
  unity_version: '',
  unity_path: '',
  execute_method: '',
  scenesText: '',
  defines: '',
  version_name: '1.0.0',
  version_code: 1,
  development: false,
  keep_debug_symbols: false,
  runner: 'auto',
  output_name: '',
  extra_params: [],
  retention_days: 7,
  actions: [],
});

const unityOptions = computed(() => {
  const opts = [{ value: '', label: `跟随项目${project.value?.unity_version ? `（${project.value.unity_version}）` : ''}` }];
  for (const i of installations.value) opts.push({ value: i.version, label: `${i.version}（${i.source === 'host' ? '本机' : '已下载'}）` });
  return opts;
});

async function load() {
  installations.value = await api.get('/unity/installations');
  agents.value = await api.get('/agents');
  if (isNew) {
    if (form.value.project_id) project.value = await api.get(`/projects/${form.value.project_id}`);
    return;
  }
  const c = await api.get(`/configs/${configId}`);
  form.value = { ...c, scenesText: (c.scenes ?? []).join('\n'), unity_version: c.unity_version ?? '', unity_path: c.unity_path ?? '', execute_method: c.execute_method ?? '', output_name: c.output_name ?? '' };
  project.value = await api.get(`/projects/${c.project_id}`);
  await loadTrigger();
}

async function save(buildAfter = false) {
  saving.value = true;
  error.value = '';
  try {
    const payload = {
      ...form.value,
      scenes: form.value.scenesText.split('\n').map((s: string) => s.trim()).filter(Boolean),
      unity_version: form.value.unity_version || null,
      unity_path: form.value.unity_path || null,
      execute_method: String(form.value.execute_method ?? '').trim(),
      output_name: form.value.output_name || null,
      version_code: Number(form.value.version_code) || 0,
      retention_days: Number(form.value.retention_days) || 0,
      scenesText: undefined,
    };
    const saved = isNew ? await api.post('/configs', payload) : await api.put(`/configs/${configId}`, payload);
    if (buildAfter) {
      const b = await api.post(`/engine/configs/${saved.id}/build`, { params: [] });
      router.push(`/builds/${b.id}`);
    } else {
      router.push(`/projects/${saved.project_id}`);
    }
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>{{ isNew ? '新建构建配置' : '编辑构建配置' }}</h1>
        <div class="sub" v-if="project">项目：{{ project.name }}</div>
      </div>
      <div class="row">
        <button class="btn" @click="router.back()">返回</button>
        <button class="btn" :disabled="saving" @click="save(false)">保存</button>
        <button class="btn primary" :disabled="saving" @click="save(true)">保存并构建</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">基本设置</div>
      <div class="grid2">
        <div class="field">
          <label>配置名称</label>
          <input class="input" v-model="form.name" placeholder="例如: Android 正式包" />
        </div>
        <div class="field">
          <label>目标平台</label>
          <select class="select" v-model="form.build_target">
            <option v-for="t in TARGETS" :key="t" :value="t">{{ t }}</option>
          </select>
          <div class="hint" v-if="form.build_target === 'iOS'">iOS 构建需要 macOS 宿主（依赖 Xcode）</div>
        </div>
        <div class="field">
          <label>Unity 版本</label>
          <select class="select" v-model="form.unity_version">
            <option v-for="o in unityOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <div class="hint">必须与工程 ProjectVersion.txt 的完整版本一致，不会用其他已安装版本代替</div>
        </div>
        <div class="field">
          <label>自定义 Unity 路径（可选，优先级最高）</label>
          <input class="input mono" v-model="form.unity_path" placeholder="编辑器安装目录即可，如 D:\Unity\2022.3.7f1" />
          <div class="hint">填安装目录或 Editor 目录均可，系统按当前平台自动定位可执行文件（Windows 为 Unity.exe）</div>
        </div>
        <div class="field">
          <label>运行位置</label>
          <select class="select" v-model="form.runner">
            <option value="auto">自动路由（iOS/macOS 派给 macOS Agent，其余优先本机）</option>
            <option value="local">仅本机构建</option>
            <option v-for="a in agents" :key="a.id" :value="a.id">指定 Agent：{{ a.name }}{{ a.online ? '' : '（离线）' }}</option>
          </select>
        </div>
        <div class="field">
          <label>输出文件名（可选）</label>
          <input class="input mono" v-model="form.output_name" placeholder="留空按平台默认，如 App.exe / app.apk" />
        </div>
        <div class="field">
          <label>executeMethod</label>
          <input class="input mono" v-model="form.execute_method" placeholder="BuildCli.Run" />
          <div class="hint">必须是仓库中已有的静态方法，不再使用内置 BuildPlayer</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">构建参数</div>
      <div class="grid2">
        <div class="field">
          <label>版本号 versionName</label>
          <input class="input mono" v-model="form.version_name" />
        </div>
        <div class="field">
          <label>versionCode（Android）</label>
          <input class="input mono" type="number" v-model="form.version_code" />
        </div>
      </div>
      <div class="field">
        <label>场景列表（每行一个 Assets 路径，留空使用 EditorBuildSettings 中启用的场景）</label>
        <textarea class="textarea" rows="3" v-model="form.scenesText" placeholder="Assets/Scenes/Main.unity"></textarea>
      </div>
      <div class="grid2">
        <div class="field">
          <label>Define Symbols（分号分隔）</label>
          <input class="input mono" v-model="form.defines" placeholder="UNITY_RELEASE;NO_DEBUG" />
        </div>
        <div class="field">
          <label class="row" style="gap:8px;cursor:pointer;margin-top:22px">
            <input type="checkbox" v-model="form.development" /> Development 构建
          </label>
          <label class="row" style="gap:8px;cursor:pointer;margin-top:10px">
            <input type="checkbox" v-model="form.keep_debug_symbols" /> 保留调试符号目录
          </label>
          <div class="hint">默认归档时剔除 *_BackUpThisFolder / *_BurstDebugInformation（体积很大）；做 IL2CPP 崩溃符号化时可勾选保留</div>
        </div>
      </div>
      <div class="field">
        <label>自定义参数（注入为环境变量 UCL_PARAM_*，构建时可在弹窗中覆盖）</label>
        <KvEditor v-model="form.extra_params" />
      </div>
    </div>

    <div class="card">
      <div class="card-title">产物保留</div>
      <div class="field" style="max-width:220px">
        <label>保留天数（到期自动清理产物，任务记录保留）</label>
        <input class="input" type="number" min="0" v-model="form.retention_days" />
      </div>
    </div>

    <div class="card">
      <div class="card-title">后置动作</div>
      <ActionsEditor v-model="form.actions" />
    </div>

    <div class="card" v-if="!isNew">
      <div class="card-title">触发链接</div>
      <template v-if="triggerToken">
        <div class="row">
          <input class="input mono" readonly :value="triggerUrl" @focus="($event.target as HTMLInputElement).select()" />
          <button class="btn sm" @click="copyTrigger">{{ triggerCopied ? '已复制' : '复制' }}</button>
          <button class="btn sm ghost danger" @click="rotateTrigger">重置</button>
        </div>
        <div class="hint">
          对该链接 POST 即可触发构建，无需 API Token。参数方式：<br />
          · Query：<span class="mono">?params=RES_MODE=Online,CHANNEL=official</span><br />
          · JSON：<span class="mono">{"params":[{"key":"RES_MODE","value":"Online"}]}</span><br />
          · 钉钉 outgoing 机器人：回调地址直接填此链接，群消息中写 <span class="mono">RES_MODE=Online</span> 即作为构建参数，机器人会自动回包触发结果。
        </div>
      </template>
      <template v-else>
        <div class="hint mb8">生成一个免 API Token 的触发链接，供飞书/钉钉/任意 HTTP 平台调用触发本配置构建。</div>
        <button class="btn sm" @click="rotateTrigger">生成触发链接</button>
      </template>
    </div>

    <div v-if="error" class="card" style="border-color:var(--red);color:var(--red);font-size:13px">{{ error }}</div>
  </div>
</template>
