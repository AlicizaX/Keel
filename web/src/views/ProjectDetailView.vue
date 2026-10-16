<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, fmtTime } from '../api';
import Modal from '../components/Modal.vue';
import KvEditor from '../components/KvEditor.vue';
import ProjectFormModal from '../components/ProjectFormModal.vue';

const route = useRoute();
const router = useRouter();
const id = route.params.id as string;

const project = ref<any>(null);
const configs = ref<any[]>([]);
const checking = ref(false);
const clearing = ref(false);

const buildTarget = ref<any>(null);
const buildParams = ref<{ key: string; value: string }[]>([]);
const starting = ref(false);
const showEdit = ref(false);

async function load() {
  project.value = await api.get(`/projects/${id}`);
  configs.value = await api.get(`/configs?projectId=${id}`);
}

async function check() {
  checking.value = true;
  try {
    project.value = await api.post(`/projects/${id}/check`);
  } finally {
    checking.value = false;
  }
}

async function clearCache() {
  if (!confirm('确定清除该项目的 Unity Library 缓存？下次构建会重新导入资源。')) return;
  clearing.value = true;
  try {
    await api.post(`/projects/${id}/clear-cache`);
    alert('已清除 Library 缓存');
  } catch (e: any) {
    alert(e.message);
  } finally {
    clearing.value = false;
  }
}

function openBuild(c: any) {
  buildTarget.value = c;
  buildParams.value = (c.extra_params ?? []).map((p: any) => ({ ...p }));
}

async function startBuild() {
  starting.value = true;
  try {
    const params = buildParams.value.filter((p) => p.key.trim());
    const b = await api.post(`/engine/configs/${buildTarget.value.id}/build`, { params });
    buildTarget.value = null;
    router.push(`/builds/${b.id}`);
  } catch (e: any) {
    alert(e.message);
  } finally {
    starting.value = false;
  }
}

async function removeConfig(c: any) {
  if (!confirm(`确定删除配置「${c.name}」？`)) return;
  try {
    await api.del(`/configs/${c.id}`);
    load();
  } catch (e: any) {
    alert(e.message);
  }
}

onMounted(load);
</script>

<template>
  <div class="page" v-if="project">
    <div class="page-header">
      <div>
        <h1>{{ project.name }}</h1>
        <div class="sub mono">{{ project.source_type === 'git' ? `${project.git_url}${project.git_branch ? ' @ ' + project.git_branch : ''}` : project.path }}</div>
      </div>
      <div class="row">
        <button class="btn" @click="showEdit = true">编辑项目</button>
        <button class="btn" :disabled="checking" @click="check">{{ checking ? '检测中...' : '重新检测' }}</button>
        <button class="btn" :disabled="clearing" @click="clearCache">{{ clearing ? '清除中...' : '清除 Library 缓存' }}</button>
        <button class="btn primary" :disabled="!project.valid" @click="router.push(`/configs/new?projectId=${id}`)">+ 新建构建配置</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">工程信息</div>
      <div class="row" style="gap:28px;flex-wrap:wrap">
        <div>
          <div class="faint" style="font-size:12px">状态</div>
          <span class="badge" :class="project.valid ? 'green' : 'red'"><span class="dot"></span>{{ project.valid ? '有效 Unity 工程' : '无效' }}</span>
        </div>
        <div>
          <div class="faint" style="font-size:12px">Unity 版本</div>
          <span class="mono">{{ project.unity_version ?? '未识别' }}</span>
        </div>
        <div>
          <div class="faint" style="font-size:12px">来源</div>
          <span class="tag">{{ project.source_type === 'git' ? 'Git' : '本地' }}</span>
        </div>
        <div>
          <div class="faint" style="font-size:12px">最近更新</div>
          <span class="mono muted">{{ fmtTime(project.updated_at) }}</span>
        </div>
      </div>
      <div v-if="project.message" class="hint mt8">{{ project.message }}</div>
    </div>

    <div class="card">
      <div class="card-title">
        构建配置
        <span class="faint" style="font-size:12px;font-weight:400">{{ configs.length }} 个</span>
      </div>
      <table class="table" v-if="configs.length">
        <thead>
          <tr>
            <th>名称</th>
            <th style="width:100px">平台</th>
            <th style="width:130px">Unity 版本</th>
            <th style="width:90px">保留天数</th>
            <th style="width:90px">后置动作</th>
            <th style="width:200px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in configs" :key="c.id">
            <td>{{ c.name }}</td>
            <td><span class="tag">{{ c.build_target }}</span></td>
            <td class="mono muted">{{ c.unity_version ?? project.unity_version ?? '-' }}</td>
            <td class="muted">{{ c.retention_days }} 天</td>
            <td class="muted">{{ (c.actions ?? []).length }} 个</td>
            <td>
              <div class="row">
                <button class="btn sm primary" @click="openBuild(c)">构建</button>
                <button class="btn sm" @click="router.push(`/configs/${c.id}/edit`)">编辑</button>
                <button class="btn sm ghost danger" @click="removeConfig(c)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无构建配置</div>
    </div>

    <ProjectFormModal v-if="showEdit" :project="project" @close="showEdit = false" @saved="(p) => { showEdit = false; project = p; }" />

    <Modal v-if="buildTarget" :title="`参数化构建 · ${buildTarget.name}`" @close="buildTarget = null">
      <div class="field">
        <label>构建参数（覆盖配置默认值，将作为环境变量 UCL_PARAM_* 注入脚本）</label>
        <KvEditor v-model="buildParams" />
      </div>
      <div class="actions">
        <button class="btn" @click="buildTarget = null">取消</button>
        <button class="btn primary" :disabled="starting" @click="startBuild">{{ starting ? '入队中...' : '开始构建' }}</button>
      </div>
    </Modal>
  </div>
</template>
