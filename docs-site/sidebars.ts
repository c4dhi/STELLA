import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: '🏠 Welcome',
    },
    {
      type: 'html',
      value: '<div class="sidebar-section-spacer"></div>',
    },
    {
      type: 'category',
      label: '🚀 Guides',
      collapsed: false,
      items: [
        'guides/getting-started',
        'guides/build-your-own-agent',
        'guides/custom-tools',
        'guides/add-custom-ui',
        'guides/authentication',
      ],
    },
    {
      type: 'html',
      value: '<div class="sidebar-section-spacer"></div>',
    },
    {
      type: 'category',
      label: '🏗️ Architecture',
      collapsed: false,
      items: [
        'architecture/overview',
        'architecture/data-flow',
        'architecture/session-lifecycle',
        'architecture/tts-pipeline',
        'architecture/database',
        'architecture/kubernetes-orchestration',
        'architecture/environment-variables',
      ],
    },
    {
      type: 'html',
      value: '<div class="sidebar-section-spacer"></div>',
    },
    {
      type: 'category',
      label: '🤖 Agents',
      collapsed: false,
      items: [
        'agents/overview',
        {
          type: 'category',
          label: '🧠 stella-v2',
          collapsed: true,
          link: {
            type: 'doc',
            id: 'agents/stella-v2/index',
          },
          items: [
            'agents/stella-v2/pipeline-configurator',
            'agents/stella-v2/pipeline-schema',
          ],
        },
        {
          type: 'category',
          label: '🌟 stella-agent',
          collapsed: true,
          link: {
            type: 'doc',
            id: 'agents/stella-agent/index',
          },
          items: [
            'agents/stella-agent/expert-pool-overview',
            'agents/stella-agent/default-experts',
            'agents/stella-agent/configuration',
            'agents/stella-agent/custom-experts',
          ],
        },
        'agents/stella-light-agent',
        'agents/echo-agent',
      ],
    },
    {
      type: 'html',
      value: '<div class="sidebar-section-spacer"></div>',
    },
    {
      type: 'category',
      label: '📋 Plan Structure',
      collapsed: false,
      items: [
        'plan-structure/index',
        'plan-structure/plan-builder',
        'plan-structure/states',
        'plan-structure/tasks',
        'plan-structure/deliverables',
        'plan-structure/examples',
        'plan-structure/json-schema-reference',
      ],
    },
    {
      type: 'html',
      value: '<div class="sidebar-section-spacer"></div>',
    },
    {
      type: 'category',
      label: '📦 SDK Reference',
      collapsed: false,
      items: [
        'sdk/overview',
        'sdk/base-agent',
        'sdk/message-types',
        'sdk/tools',
        'sdk/streaming',
        'sdk/prompt-compiler',
        'sdk/typescript-types',
      ],
    },
    {
      type: 'html',
      value: '<div class="sidebar-section-spacer"></div>',
    },
    {
      type: 'category',
      label: '🚢 Deployment',
      collapsed: false,
      items: [
        'deployment/kubernetes',
        'deployment/production',
        'deployment/message-recording',
        'deployment/production-checklist',
        'deployment/monitoring',
        'deployment/agent-validation',
        'deployment/backup-restore',
      ],
    },
    {
      type: 'html',
      value: '<div class="sidebar-section-spacer"></div>',
    },
    {
      type: 'category',
      label: '🔗 Integration',
      collapsed: false,
      items: [
        'integration/livekit',
        'integration/livekit-production',
        'integration/frontend',
      ],
    },
    {
      type: 'html',
      value: '<div class="sidebar-section-spacer"></div>',
    },
    {
      type: 'category',
      label: '🤝 Contributing',
      collapsed: false,
      items: [
        'contributing/index',
        'contributing/development-setup',
        {
          type: 'category',
          label: 'Coding Standards',
          collapsed: true,
          link: {
            type: 'doc',
            id: 'contributing/coding-standards/index',
          },
          items: [
            'contributing/coding-standards/typescript',
            'contributing/coding-standards/python',
            'contributing/coding-standards/react',
            'contributing/coding-standards/git',
            'contributing/coding-standards/testing',
          ],
        },
        'contributing/agent-failure-collection',
        'contributing/pull-request-process',
        'contributing/release-process',
      ],
    },
  ],
};

export default sidebars;
