import React from 'react';
import {useLocation, useHistory} from '@docusaurus/router';
import styles from './styles.module.css';

// Try to import version hooks - they may not be available in all contexts
let useVersions: () => any[];
let useActiveDocContext: () => { activeVersion?: any };
let useDocsPreferredVersion: () => { preferredVersion?: any; savePreferredVersionName: (name: string) => void };

try {
  const client = require('@docusaurus/plugin-content-docs/client');
  useVersions = client.useVersions;
  useActiveDocContext = client.useActiveDocContext;
  const themeCommon = require('@docusaurus/theme-common');
  useDocsPreferredVersion = themeCommon.useDocsPreferredVersion;
} catch (e) {
  // Fallback if hooks are not available
  useVersions = () => [];
  useActiveDocContext = () => ({});
  useDocsPreferredVersion = () => ({ savePreferredVersionName: () => {} });
}

export default function VersionSelector(): React.JSX.Element {
  const location = useLocation();
  const history = useHistory();

  let versions: any[] = [];
  let activeVersion: any = null;
  let preferredVersion: any = null;
  let savePreferredVersionName: (name: string) => void = () => {};

  try {
    versions = useVersions() || [];
    const docContext = useActiveDocContext() || {};
    activeVersion = docContext.activeVersion;
    const prefVersion = useDocsPreferredVersion() || {};
    preferredVersion = prefVersion.preferredVersion;
    savePreferredVersionName = prefVersion.savePreferredVersionName || (() => {});
  } catch (e) {
    // Hooks not available in this context
  }

  const currentVersion = activeVersion ?? preferredVersion ?? versions[0];
  const hasMultipleVersions = versions.length > 1;
  const versionLabel = currentVersion?.label || '0.2.0';

  const handleVersionChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const newVersionName = event.target.value;
    const newVersion = versions.find((v) => v.name === newVersionName);

    if (newVersion) {
      savePreferredVersionName(newVersionName);

      // Navigate to the same doc in the new version if possible
      const currentPath = location.pathname;
      let newPath = newVersion.path;

      // Try to preserve the current doc path
      if (activeVersion && currentPath.startsWith(activeVersion.path)) {
        const docPath = currentPath.slice(activeVersion.path.length);
        newPath = newVersion.path + docPath;
      }

      history.push(newPath || '/docs');
    }
  };

  // Single version or no versions - show as a badge
  if (!hasMultipleVersions) {
    return (
      <div className={styles.versionSelector}>
        <div className={styles.versionBadge}>
          <span className={styles.versionBadgeLabel}>Version</span>
          <span className={styles.versionBadgeValue}>{versionLabel}</span>
        </div>
      </div>
    );
  }

  // Multiple versions - show dropdown
  return (
    <div className={styles.versionSelector}>
      <div className={styles.versionLabel}>Version</div>
      <div className={styles.selectWrapper}>
        <select
          className={styles.select}
          value={currentVersion?.name || ''}
          onChange={handleVersionChange}
        >
          {versions.map((version) => (
            <option key={version.name} value={version.name}>
              {version.label}
              {version.name === 'current' && ' (dev)'}
            </option>
          ))}
        </select>
        <svg
          className={styles.chevron}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M2.5 4.5L6 8L9.5 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
