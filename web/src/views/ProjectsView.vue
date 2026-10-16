<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import ProjectFormModal from '../components/ProjectFormModal.vue';

const router = useRouter();
const projects = ref<any[]>([]);
const showForm = ref(false);
const editing = ref<any | null>(null);

async function load() {
  projects.value = await api.get('/projects');
}

function openAdd() {
  editing.value = null;
  showForm.value = true;
}

function openEdit(p: any, e: Event) {
  e.stopPropagation();
  editing.value = p;
  showForm.value = true;
}

function onSaved(p: any) {
  showForm.value = false;
  load();
  if (!editing.value) router.push(`/projects/${p.id}`);
}

async function remove(p: any, e: Event) {
  e.stopPropagation();
  if (!confirm(`确定删除项目「${p.name}」？（需无构建记录）`)) return;
  try {
    await api.del(`/projects/${p.id}`);
    load();
  } catch (err: any) {
    alert(err.message);
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-header">
      <div>
        <h1>项目</h1>
        <div class="sub">接入本地 Unity 工程或 Git 仓库</div>
      </div>
      <button class="btn primary" @click="openAdd">+ 添加项目</button>
    </div>

    <div class="card">
      <table class="table" v-if="projects.length">
        <thead>
          <tr>
            <th>名称</th>
            <th style="width:90px">来源</th>
            <th>路径 / 仓库</th>
            <th style="width:130px">Unity 版本</th>
            <th style="width:90px">状态</th>
            <th style="width:80px">配置数</th>
            <th style="width:130px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in projects" :key="p.id" class="clickable" @click="router.push(`/projects/${p.id}`)">
            <td>{{ p.name }}</td>
            <td><span class="tag">{{ p.source_type === 'git' ? 'Git' : '本地' }}</span></td>
            <td class="mono muted" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {{ p.source_type === 'git' ? `${p.git_url}${p.git_branch ? ' @ ' + p.git_branch : ''}` : p.path }}
            </td>
            <td class="mono">{{ p.unity_version ?? '-' }}</td>
            <td>
              <span class="badge" :class="p.valid ? 'green' : 'red'"><span class="dot"></span>{{ p.valid ? '有效' : '无效' }}</span>
            </td>
            <td class="muted">{{ p.config_count }}</td>
            <td>
              <div class="row" style="gap:6px">
                <button class="btn sm" @click="openEdit(p, $event)">编辑</button>
                <button class="btn sm ghost danger" @click="remove(p, $event)">删除</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">还没有项目，点击右上角「添加项目」开始</div>
    </div>

    <ProjectFormModal v-if="showForm" :project="editing" @close="showForm = false" @saved="onSaved" />
  </div>
</template>
