<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, setToken } from '../api';

const settings = ref<Record<string, string>>({});
const installations = ref<any[]>([]);
const saving = ref(false);
const installPath = ref('');
const adding = ref(false);
const message = ref('');
const messageError = ref(false);

// 版本搜索与下载
const searchQuery = ref('');
const searchResults = ref<any[]>([]);
const searching = ref(false);
const searched = ref(false);
const selectedVersion = ref('');
const selectedModules = ref<string[]>([]);
const downloading = ref(false);

// 远程 Runner
const agents = ref<any[]>([]);
const newAgentName = ref('');
const createdAgent = ref<any | null>(null);

async function loadAgents() {
  agents.value = await api.get('/agents');
}

async function createAgent() {
  if (!newAgentName.value.trim()) return;
  try {
    createdAgent.value = await api.post('/agents', { name: newAgentName.value.trim() });
    newAgentName.value = '';
    loadAgents();
  } catch (e: any) {
    notify(e.message, true);
  }
}

async function removeAgent(a: any) {
  if (!confirm(`确定删除 Agent「${a.name}」？其 token 立即失效`)) return;
  try {
    await api.del(`/agents/${a.id}`);
    if (createdAgent.value?.id === a.id) createdAgent.value = null;
    loadAgents();
  } catch (e: any) {
    notify(e.message, true);
  }
}

const currentModules = computed(() => {
  const r = searchResults.value.find((x) => x.version === selectedVersion.value);
  return r?.modules ?? [];
});

function notify(text: string, isError = false) {
  message.value = text;
  messageError.value = isError;
  setTimeout(() => (message.value = ''), 4000);
}

async function load() {
  settings.value = await api.get('/settings');
  installations.value = await api.get('/unity/installations');
  await loadAgents();
}

async function save() {
  saving.value = true;
  try {
    const payload = { ...settings.value };
    settings.value = await api.put('/settings', payload);
    setToken(settings.value.api_token ?? '');
    notify('设置已保存');
  } catch (e: any) {
    notify(e.message, true);
  } finally {
    saving.value = false;
  }
}

async function addInstalled() {
  const value = installPath.value.trim();
  if (!value) return;
  adding.value = true;
  try {
    await api.post('/unity/installations', { path: value });
    installations.value = await api.get('/unity/installations');
    installPath.value = '';
    notify('已添加 Unity');
  } catch (e: any) {
    notify(e.message, true);
  } finally {
    adding.value = false;
  }
}

async function removeInstalled(i: any) {
  if (!confirm(`从列表移除 Unity ${i.version}？不会删除磁盘上的安装文件`)) return;
  try {
    await api.del(`/unity/installations/${i.id}`);
    installations.value = installations.value.filter((x) => x.id !== i.id);
  } catch (e: any) {
    notify(e.message, true);
  }
}

async function search() {
  searching.value = true;
  searched.value = false;
  try {
    searchResults.value = await api.get(`/unity/releases?version=${encodeURIComponent(searchQuery.value.trim())}`);
    searched.value = true;
    selectedVersion.value = searchResults.value[0]?.version ?? '';
  } catch (e: any) {
    notify(e.message, true);
  } finally {
    searching.value = false;
  }
}

function toggleModule(id: string) {
  if (selectedModules.value.includes(id)) {
    selectedModules.value = selectedModules.value.filter((m) => m !== id);
  } else {
    selectedModules.value = [...selectedModules.value, id];
  }
}

async function download() {
  if (!selectedVersion.value) return;
  downloading.value = true;
  try {
    await api.post('/unity/download', { version: selectedVersion.value, modules: selectedModules.value });
    installations.value = await api.get('/unity/installations');
    notify(`Unity ${selectedVersion.value} 安装完成`);
  } catch (e: any) {
    notify(e.message, true);
  } finally {
    downloading.value = false;
  }
}

function moduleNames(i: any): string {
  try {
    const ids: string[] = JSON.parse(i.modules ?? '[]');
    return ids.length ? ids.join(', ') : '-';
  } catch {
    return '-';
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>设置</h1>
        <div class="sub">构建引擎、Unity 安装与授权、接口安全</div>
      </div>
      <button class="btn primary" :disabled="saving" @click="save">{{ saving ? '保存中...' : '保存设置' }}</button>
    </div>

    <div class="card">
      <div class="card-title">构建引擎</div>
      <div class="grid2">
        <div class="field">
          <label>并发构建数</label>
          <input class="input" type="number" min="1" v-model="settings.concurrency" />
          <div class="hint">开启 Library 复用时同一项目始终互斥；关闭后仅同一本地目录互斥，Git 项目可并行</div>
        </div>
        <div class="field">
          <label>脚本超时（秒）</label>
          <input class="input" type="number" min="60" v-model="settings.script_timeout" />
          <div class="hint">用于后置动作中的自定义脚本</div>
        </div>
        <div class="field">
          <label class="row" style="gap:8px;cursor:pointer">
            <input type="checkbox" :checked="settings.reuse_unity_library !== 'false'" @change="settings.reuse_unity_library = ($event.target as HTMLInputElement).checked ? 'true' : 'false'" />
            复用 Unity Library（加速后续构建）
          </label>
          <div class="hint">每个目标平台单独一份 Library，并按 ProjectVersion、manifest、packages-lock 和 ProjectSettings 隔离。依赖变化时自动重建。关闭则每次使用干净工作区</div>
        </div>
        <div class="field">
          <label class="row" style="gap:8px;cursor:pointer">
            <input type="checkbox" :checked="settings.keep_failed_workspace === 'true'" @change="settings.keep_failed_workspace = ($event.target as HTMLInputElement).checked ? 'true' : 'false'" />
            构建失败时保留工作区副本
          </label>
          <div class="hint">仅在关闭 Library 复用时生效。默认构建结束后删除临时工作区；开启后失败现场会保留用于排查</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Unity 安装</div>
      <div class="field">
        <label>下载安装目录（留空自动检测）</label>
        <input class="input mono" v-model="settings.unity_install_root" placeholder="例如 D:\Unity\Editors 或 /opt/unity" />
        <div class="hint">
          留空时自动检测本机目录：优先使用 Unity Hub 的 Editor 目录（Windows / macOS / Linux 均支持），不存在则使用工具数据目录。
          下载的安装包缓存会在安装结束后自动清除。
        </div>
      </div>
      <div class="field">
        <label>添加已安装 Unity</label>
        <div class="row">
          <input
            class="input mono"
            v-model="installPath"
            placeholder="版本目录，如 D:\Unity\2022.3.7f1"
            @keyup.enter="addInstalled"
          />
          <button class="btn sm" :disabled="adding || !installPath.trim()" @click="addInstalled">{{ adding ? '添加中...' : '添加' }}</button>
        </div>
        <div class="hint">一次添加一个已安装目录。不会扫描本机其他 Unity。</div>
      </div>

      <div class="field">
        <label>搜索 Unity 版本并下载（仅 Linux 环境可安装）</label>
        <div class="row">
          <input
            class="input mono"
            style="max-width:260px"
            v-model="searchQuery"
            placeholder="例如 2022.3 或 2022.3.45f1"
            @keyup.enter="search"
          />
          <button class="btn" :disabled="searching || !searchQuery.trim()" @click="search">
            {{ searching ? '搜索中...' : '搜索' }}
          </button>
        </div>
      </div>

      <template v-if="searchResults.length">
        <div class="field">
          <label>选择版本</label>
          <div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto">
            <label v-for="r in searchResults" :key="r.version" class="row" style="gap:8px;cursor:pointer">
              <input type="radio" name="unity-version" :value="r.version" v-model="selectedVersion" />
              <span class="mono">{{ r.version }}</span>
              <span class="faint" style="font-size:12px">{{ r.stream }} {{ r.releaseDate }}</span>
            </label>
          </div>
        </div>

        <div class="field" v-if="selectedVersion">
          <label>安装模块（每次安装可单独勾选；已装版本再次下载可补充模块）</label>
          <div class="grid2">
            <label
              v-for="m in currentModules"
              :key="m.id"
              class="row"
              style="gap:8px;cursor:pointer;padding:3px 0"
              :style="{ opacity: m.available ? 1 : 0.45 }"
            >
              <input type="checkbox" :checked="selectedModules.includes(m.id)" @change="toggleModule(m.id)" />
              <span>{{ m.name }}</span>
              <span class="faint mono" style="font-size:11px">{{ m.id }}</span>
            </label>
          </div>
          <div class="hint">置灰项表示该版本发布信息中未提供下载地址，勾选后会尝试安装并提示手动方式</div>
        </div>

        <div class="field">
          <button class="btn primary" :disabled="downloading || !selectedVersion" @click="download">
            {{ downloading ? '下载安装中（可能较久）...' : `下载并安装 ${selectedVersion}` }}
          </button>
        </div>
      </template>
      <div v-else-if="searched" class="empty" style="padding:16px 0">未找到匹配版本</div>

      <table class="table" v-if="installations.length">
        <thead>
          <tr><th>版本</th><th>路径</th><th style="width:80px">来源</th><th>已装模块</th><th style="width:70px"></th></tr>
        </thead>
        <tbody>
          <tr v-for="i in installations" :key="i.id">
            <td class="mono">{{ i.version }}</td>
            <td class="mono muted" style="font-size:12px">{{ i.path }}</td>
            <td><span class="tag">{{ i.source === 'downloaded' ? '已下载' : '已安装' }}</span></td>
            <td class="muted" style="font-size:12px">{{ moduleNames(i) }}</td>
            <td><button class="btn sm ghost danger" @click="removeInstalled(i)">移除</button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">还没有 Unity。下载安装，或添加一个已安装目录。</div>
    </div>

    <div class="card">
      <div class="card-title">远程 Runner（Agent）</div>
      <div class="hint mb8">
        在构建机（如 Mac）上以 Agent 模式运行即可接入：<br />
        <span class="mono">npm run agent -w server -- --server http://&lt;主实例地址&gt;:7850 --token &lt;token&gt; --name &lt;名称&gt;</span><br />
        队列按平台自动路由：iOS/macOS 任务派给 macOS Agent，其余优先本机。Agent 主动外连，无需对外开放端口。
      </div>
      <div class="row mb8">
        <input class="input" style="max-width:220px" v-model="newAgentName" placeholder="Agent 名称，如 mac-mini" @keyup.enter="createAgent" />
        <button class="btn sm" :disabled="!newAgentName.trim()" @click="createAgent">创建 Agent</button>
      </div>
      <div v-if="createdAgent" class="field">
        <label>Token（仅显示这一次，请妥善保存）</label>
        <input class="input mono" readonly :value="createdAgent.token" @focus="($event.target as HTMLInputElement).select()" />
      </div>
      <table class="table" v-if="agents.length">
        <thead>
          <tr><th>名称</th><th style="width:90px">平台</th><th style="width:110px">状态</th><th style="width:160px">最近在线</th><th style="width:70px"></th></tr>
        </thead>
        <tbody>
          <tr v-for="a in agents" :key="a.id">
            <td>{{ a.name }}</td>
            <td class="mono muted">{{ a.platform ?? '-' }}</td>
            <td>
              <span class="badge" :class="a.online ? 'green' : 'gray'">
                <span class="dot"></span>{{ a.online ? (a.busy ? '构建中' : '在线') : '离线' }}
              </span>
            </td>
            <td class="mono muted" style="font-size:12px">{{ a.last_seen_at ? new Date(a.last_seen_at).toLocaleString('zh-CN', { hour12: false }) : '-' }}</td>
            <td><button class="btn sm ghost danger" @click="removeAgent(a)">删除</button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty" style="padding:20px 0">暂无 Agent，创建一个后在构建机上启动即可</div>
    </div>

    <div class="card">
      <div class="card-title">Unity 授权（批处理构建需要有效许可）</div>
      <div class="grid2">
        <div class="field">
          <label>Unity 账号</label>
          <input class="input" v-model="settings.license_username" placeholder="email" />
        </div>
        <div class="field">
          <label>密码</label>
          <input class="input" type="password" v-model="settings.license_password" />
        </div>
        <div class="field">
          <label>序列号（Pro/Plus）</label>
          <input class="input mono" v-model="settings.license_serial" placeholder="XX-XXXX-XXXX-XXXX-XXXX" />
        </div>
        <div class="field">
          <label>ULF 授权文件路径（离线授权，优先级最高）</label>
          <input class="input mono" v-model="settings.license_ulf_path" placeholder="/data/license/Unity_v2022.x.ulf" />
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">接口安全</div>
      <div class="field" style="max-width:360px">
        <label>API Token（设置后，所有写操作需携带请求头 x-api-token）</label>
        <input class="input mono" v-model="settings.api_token" placeholder="留空表示不启用" />
      </div>
    </div>

    <div v-if="message" class="toast" :class="{ error: messageError }">{{ message }}</div>
  </div>
</template>
