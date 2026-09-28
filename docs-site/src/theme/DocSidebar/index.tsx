import React from 'react';
import DocSidebar from '@theme-original/DocSidebar';
import type DocSidebarType from '@theme/DocSidebar';
import type {WrapperProps} from '@docusaurus/types';
import VersionSelector from '@site/src/components/VersionSelector';
import styles from './styles.module.css';

type Props = WrapperProps<typeof DocSidebarType>;

export default function DocSidebarWrapper(props: Props): React.JSX.Element {
  return (
    <div className={styles.sidebarWrapper}>
      <div className={styles.versionSelectorContainer}>
        <VersionSelector />
      </div>
      <DocSidebar {...props} />
    </div>
  );
}
