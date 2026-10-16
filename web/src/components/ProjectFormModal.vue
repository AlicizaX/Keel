<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from '../api';
import Modal from './Modal.vue';

const props = defineProps<{ project?: any | null }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'saved', p: any): void }>();

const isEdit = !!props.project;
const saving = ref(false);
const error = ref('');
const form = ref({
  name: props.project?.name ?? '',
  source_type: (props.project?.source_type ?? 'local') as 'local' | 'git',
  path: props.project?.path ?? '',
  git_url: props.project?.git_url ?? '',
  git_branch: props.project?.git_branch ?? '',
  project_path: props.project?.project_path ?? '',
  git_lfs: !!props.project?.git_lfs,
  git_submodules: !!props.project?.git_submodules,
});

async function submit() {
  saving.value = true;
  error.value = '';
  try {
    const payload = {
      name: form.value.name,
      source_type: form.value.source_type,
      path: form.value.path || undefined,
      git_url: form.value.git_url || undefined,
      git_branch: form.value.git_branch || undefined,
      project_path: form.value.project_path || undefined,
      git_lfs: form.value.git_lfs,
      git_submodules: form.value.git_submodules,
    };
    let saved: any;
    if (isEdit) {
      saved = await api.put(`/projects/${props.project.id}`, payload);
      // 来源信息可能变化，重新检测有效性与版本
      saved = await api.post(`/projects/${saved.id}/check`);
    } else {
      saved = await api.post('/projects', payload);
    }
    emit('saved', saved);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal :title="isEdit ? '编辑项目' : '添加项目'" @close="emit('close')">
    <div class="field">
      <label>项目名称</label>
      <input class="input" v-model="form.name" placeholder="例如: MyGame" />
    </div>
    <div class="field">
      <label>项目来源</label>
      <div class="row" v-if="!isEdit">
        <button class="btn sm" :class="{ primary: form.source_type === 'local' }" @click="form.source_type = 'local'">本地目录</button>
        <button class="btn sm" :class="{ primary: form.source_type === 'git' }" @click="form.source_type = 'git'">Git 仓库</button>
      </div>
      <span v-else class="tag">{{ form.source_type === 'git' ? 'Git' : '本地' }}</span>
    </div>
    <template v-if="form.source_type === 'local'">
      <div class="field">
        <label>本地路径</label>
        <input class="input mono" v-model="form.path" placeholder="D:\Projects\MyGame 或 /home/user/MyGame" />
        <div class="hint">指向 Unity 工程根目录（包含 Assets 与 ProjectSettings）</div>
      </div>
    </template>
    <template v-else>
      <div class="field">
        <label>仓库地址</label>
        <input class="input mono" v-model="form.git_url" placeholder="https://github.com/org/repo.git 或 git@github.com:org/repo.git" />
      </div>
      <div class="field">
        <label>分支（留空使用默认分支）</label>
        <input class="input mono" v-model="form.git_branch" placeholder="main" />
      </div>
      <div class="field">
        <label>Unity 工程相对路径（仓库根就是工程时留空）</label>
        <input class="input mono" v-model="form.project_path" placeholder="Client" />
      </div>
      <div class="field">
        <label class="row" style="gap:8px;cursor:pointer">
          <input type="checkbox" v-model="form.git_submodules" /> 拉取子模块
        </label>
      </div>
      <div class="field">
        <label class="row" style="gap:8px;cursor:pointer">
          <input type="checkbox" v-model="form.git_lfs" /> 拉取 Git LFS
        </label>
      </div>
    </template>
    <div v-if="error" class="hint" style="color:var(--red)">{{ error }}</div>
    <div class="actions">
      <button class="btn" @click="emit('close')">取消</button>
      <button class="btn primary" :disabled="saving" @click="submit">
        {{ saving ? (isEdit ? '保存并检测中...' : '添加并检测中...') : isEdit ? '保存' : '添加并检测' }}
      </button>
    </div>
  </Modal>
</template>
