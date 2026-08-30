/** 浏览器入口：依次安装 Pinia、路由并挂载根组件。业务组合从 TradeView 开始。 */
import { createApp } from "vue";
import { createPinia } from "pinia";

import App from "./App.vue";
import { createAppRouter } from "./router/index.js";
import "./styles/main.css";

const app = createApp(App);
app.use(createPinia());
app.use(createAppRouter());
app.mount("#app");
