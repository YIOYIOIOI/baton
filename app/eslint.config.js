// https://docs.expo.dev/guides/using-eslint/
//
// 2026-09-28 之前这个文件不在仓库里，于是 `npm run lint` 在每一个干净的检出上都会
// **改写仓库**——expo lint 找不到配置就自动生成一份（「No ESLint config found.
// Configuring automatically.」）。它本来就是要提交的。
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    // .expo/ 是 expo 生成的类型声明，不是我们写的
    ignores: ['dist/*', '.expo/*'],
  },
  {
    // 构建期的 node 脚本，不是 App 代码
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    /*
      React Compiler 的几条规则降为警告。**不是嫌它们吵，是它们报的不是 bug。**

      app.json 开着 `experiments.reactCompiler`。编译器碰到违反这些规则的组件会
      **跳过优化、按普通组件跑**——不会跑坏。lint 报出来的正是被跳过的那些。

      而被跳过的地方大半是刻意的，就地都有注释：
        refs                 读 ref.current 算显示值，**为的就是不进 state**——
                             进 state 每来一批事件就多渲染一次，而没有界面读它
                             （见 useSessionLive.ts 里 resumeAt / lastEventAt 那几段）
        set-state-in-effect  外部状态（网络、AppState、键盘）回来之后同步进 React
        purity               LinkSheet 打开那一刻取一次 Date.now()，本来就不要它每秒变

      照 lint 改等于撤掉这些决定，改的还是键盘、滚动这些反复调过的代码。
      留成警告：数量看得见，**真正的错误（rules-of-hooks、immutability……）仍是错误**，
      不会被 60 条「编译器跳过了这里」淹掉——之前 lint 恒红，恒红就等于没人看。
    */
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
]);
