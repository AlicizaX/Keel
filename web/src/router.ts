import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/queue' },
    { path: '/queue', name: 'queue', component: () => import('./views/QueueView.vue'), meta: { title: '构建队列' } },
    { path: '/projects', name: 'projects', component: () => import('./views/ProjectsView.vue'), meta: { title: '项目' } },
    { path: '/projects/:id', name: 'project-detail', component: () => import('./views/ProjectDetailView.vue'), meta: { title: '项目详情' } },
    { path: '/configs/new', name: 'config-new', component: () => import('./views/ConfigEditView.vue'), meta: { title: '新建配置' } },
    { path: '/configs/:id/edit', name: 'config-edit', component: () => import('./views/ConfigEditView.vue'), meta: { title: '编辑配置' } },
    { path: '/builds/:id', name: 'build-detail', component: () => import('./views/BuildDetailView.vue'), meta: { title: '构建详情' } },
    { path: '/artifacts', name: 'artifacts', component: () => import('./views/ArtifactsView.vue'), meta: { title: '产物' } },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue'), meta: { title: '设置' } },
  ],
});

router.afterEach((to) => {
  document.title = `${to.meta.title ?? ''} · Keel`;
});
