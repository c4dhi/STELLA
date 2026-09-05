# Changelog

All notable changes to STELLA will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0](https://github.com/c4dhi/STELLA/compare/v0.3.0...v0.4.0) (2026-09-05)


### Features

* add LiveKit health check to prestart hooks ([f6185f9](https://github.com/c4dhi/STELLA/commit/f6185f98a6f996fa81e917c331f17d2b20277a21))
* **agent-types:** publish agent-declared expert defaults, capability-gated ([d736afc](https://github.com/c4dhi/STELLA/commit/d736afcf8644a8264b637a89e046115a6728f63f))
* **backup:** full-system export/import for backup & relocation ([#378](https://github.com/c4dhi/STELLA/issues/378)) ([89d2f3a](https://github.com/c4dhi/STELLA/commit/89d2f3a0c76548f8af93af02c1a35f94d6b0bd6e))
* **backup:** guided backup & restore wizard (start-k8s.sh --backup) ([#378](https://github.com/c4dhi/STELLA/issues/378)) ([6961ac9](https://github.com/c4dhi/STELLA/commit/6961ac96d53c80dac35e9253f5b6eba66d710aea))
* **backup:** pretty-print the restore report instead of raw JSON ([#378](https://github.com/c4dhi/STELLA/issues/378)) ([9e6008a](https://github.com/c4dhi/STELLA/commit/9e6008ad663e884444143624e0f9c4f792ae661f))
* **barge-in:** text-based interruption / barge-in ([#278](https://github.com/c4dhi/STELLA/issues/278)) ([70a5f89](https://github.com/c4dhi/STELLA/commit/70a5f8960285fa732c46f709d13f518a1e560828))
* **barge-in:** text-based interruption reusing the voice plumbing ([#278](https://github.com/c4dhi/STELLA/issues/278)) ([63e224c](https://github.com/c4dhi/STELLA/commit/63e224cd6ce36536cfab84c396e237a9567b9872))
* **barge-in:** user can interrupt the agent mid-speech ([#15](https://github.com/c4dhi/STELLA/issues/15)) ([b93b44d](https://github.com/c4dhi/STELLA/commit/b93b44d519dcef59aac9f9b4f7ee4451a642f121))
* **bridge:** full Agent Configurator control + review cleanup ([84b476d](https://github.com/c4dhi/STELLA/commit/84b476df001dfc0cd814a6e0f4a10f37c417ab9d))
* **config:** manifest-driven runtime-variable palette + config min compiler version ([#240](https://github.com/c4dhi/STELLA/issues/240) [#251](https://github.com/c4dhi/STELLA/issues/251)) ([f2b6058](https://github.com/c4dhi/STELLA/commit/f2b605877804ebbd63ef892b705228dba5fff645))
* **config:** scope env-var templates & configs to agent type + version ([#240](https://github.com/c4dhi/STELLA/issues/240)) ([0db376c](https://github.com/c4dhi/STELLA/commit/0db376ce06feaedd91c70bb5aa36b2ac292e99e8))
* **configurator:** Expert Module with editable verdict-to-action responses ([9932930](https://github.com/c4dhi/STELLA/commit/9932930a92f6bef44008d318d62dada90e0f6d3e))
* **configurator:** finish [#178](https://github.com/c4dhi/STELLA/issues/178)/[#175](https://github.com/c4dhi/STELLA/issues/175)/[#177](https://github.com/c4dhi/STELLA/issues/177) — create-form parity + unsaved-changes guard ([ad22dbf](https://github.com/c4dhi/STELLA/commit/ad22dbfb86a4f8d7fb0a9a46d5197e0a0eca8f7c))
* **configurator:** manifest-driven {{placeholder}} palette + drift guard ([#251](https://github.com/c4dhi/STELLA/issues/251)) ([f445db3](https://github.com/c4dhi/STELLA/commit/f445db36fe665a7b3e2f15b5e9d58e347b4a641d))
* conversational style upgrades across v2 pipeline and SDK ([22ec988](https://github.com/c4dhi/STELLA/commit/22ec988fcb378ef6d70d57d158659915bbe9f1f1))
* **deploy:** make frontend & backend public URLs independently configurable ([203851d](https://github.com/c4dhi/STELLA/commit/203851d5b30b97b1c741c1937de8f0c07c5cda7b))
* **deploy:** STELLA_DATA_ROOT to relocate all heavy storage to a disk ([46fd48d](https://github.com/c4dhi/STELLA/commit/46fd48d5dd87f20a9c032f033fc9bca29252d80d))
* **docs-site:** researcher-focused landing page on c4dhi.github.io/STELLA ([d5b7102](https://github.com/c4dhi/STELLA/commit/d5b7102314ce69665d4b1204844c40d750dcf3d2))
* dynamic message-type picker — show only types actually stored ([cde2a46](https://github.com/c4dhi/STELLA/commit/cde2a4650860f67b949e3c95064893b0fa777d58))
* **env-vars:** group env-var templates by agent type in settings ([47b3ddf](https://github.com/c4dhi/STELLA/commit/47b3ddf5646e4c516df940a2d16f84e963fec764))
* **env-vars:** unify manual env-var add into one shared editor ([#290](https://github.com/c4dhi/STELLA/issues/290)) ([dbef514](https://github.com/c4dhi/STELLA/commit/dbef514d2b69fc36df389d93746c3c78cba50d33))
* **env-vars:** unify manual env-var add into one shared editor ([#290](https://github.com/c4dhi/STELLA/issues/290)) ([7e9534d](https://github.com/c4dhi/STELLA/commit/7e9534df991c92f5f7a0d32bddbc32f0ab74b772))
* **envvars:** surface template variables as editable override rows ([ba58ea2](https://github.com/c4dhi/STELLA/commit/ba58ea25ce3c70e438fe1be4b6b14cc0cdc072bb))
* expose full debug export option in transcript download menu ([66b64e8](https://github.com/c4dhi/STELLA/commit/66b64e868209ce48e42a3f3e57319ae8a285010f))
* fast image tagging and build fallback for deploy resilience ([83b17bd](https://github.com/c4dhi/STELLA/commit/83b17bdecd189f465f67645637c3d6a0d653aefd))
* German / multi-language prompt guidance in plan builder ([f45ae7e](https://github.com/c4dhi/STELLA/commit/f45ae7e03883734c2041d02aef14a70a01f8b8d5))
* **landing:** refine agent cards and equal-height quick-start steps ([f94c451](https://github.com/c4dhi/STELLA/commit/f94c451de58f28050c5b7822e71c44a52f7439ae))
* **landing:** replace institution logos with text and auto-fit carousel ([e9c656a](https://github.com/c4dhi/STELLA/commit/e9c656a275cd411296a6bafa15c03dc557a520c0))
* **language:** coherent per-turn language handling + RFC ([#214](https://github.com/c4dhi/STELLA/issues/214)) ([d60e611](https://github.com/c4dhi/STELLA/commit/d60e611ee5d4fbab1ef45407e2107273ff767d91))
* **language:** coherent per-turn language resolution ([#214](https://github.com/c4dhi/STELLA/issues/214)) ([6c90ff6](https://github.com/c4dhi/STELLA/commit/6c90ff6a994622a36ac85533772458f7ef14ca78))
* **language:** make resolver configurable + set defaults ([#214](https://github.com/c4dhi/STELLA/issues/214)) ([b62ebe4](https://github.com/c4dhi/STELLA/commit/b62ebe46cf6328fc4671852efa774df46b9677f2))
* **language:** STT acoustic detection end-to-end ([#214](https://github.com/c4dhi/STELLA/issues/214)) ([2dfb64c](https://github.com/c4dhi/STELLA/commit/2dfb64c3e1e1b3142ab76dc8492bcbaada69f6e6))
* **light-agent:** deliverable-driven steering + precise skip semantics ([#306](https://github.com/c4dhi/STELLA/issues/306)) ([a0f9831](https://github.com/c4dhi/STELLA/commit/a0f98312dbae6c837ff617880160f79ae1824028))
* **light-agent:** deliverable-driven steering + precise skip semantics ([#306](https://github.com/c4dhi/STELLA/issues/306)) ([85b9df6](https://github.com/c4dhi/STELLA/commit/85b9df6f393ae1078de84680f9327866a177f5a0))
* **manifest:** declare language/voice config + TTS env vars ([#214](https://github.com/c4dhi/STELLA/issues/214)) ([2958fe9](https://github.com/c4dhi/STELLA/commit/2958fe980e5b8747344c13ce947513db5e281c29))
* metrics dashboard UI with stage and plan drill-down ([ea00675](https://github.com/c4dhi/STELLA/commit/ea00675d7b57adbd288381d33334c8da04de92cd))
* **naturalness:** conversational delivery improvements ([#304](https://github.com/c4dhi/STELLA/issues/304)) ([351073a](https://github.com/c4dhi/STELLA/commit/351073aa2743a67e2efc39c2ff27b83e77cd613b))
* **participant:** independent transcript toggles + clear stale agent teleprompter ([#343](https://github.com/c4dhi/STELLA/issues/343)) ([f3a29be](https://github.com/c4dhi/STELLA/commit/f3a29bec2add4fda542d718e346f47df13ddffd1))
* Prolific study participant UX + participant-only agent auto-resume ([4f4d073](https://github.com/c4dhi/STELLA/commit/4f4d073323fa57c6633b3e0612823f2bffbb08c6))
* **readiness:** activate round-trip audio test + speaker picker ([#215](https://github.com/c4dhi/STELLA/issues/215)) ([157abb3](https://github.com/c4dhi/STELLA/commit/157abb3805b239572ce926e0155690a77ce6c3e0))
* **readiness:** activate round-trip audio test + speaker picker ([#215](https://github.com/c4dhi/STELLA/issues/215)) ([efb43b4](https://github.com/c4dhi/STELLA/commit/efb43b486cfc33c3ee4aee68ee2ea8334a3827ee))
* **sdk:** move language resolution into the SDK and adopt it in both agents (step 5) ([909bb7a](https://github.com/c4dhi/STELLA/commit/909bb7ab45b5580880d528cfacc736e72888e2fb))
* **sdk:** shared prompt-compiler library; resolve runtime placeholders in stella-light ([#240](https://github.com/c4dhi/STELLA/issues/240)) ([4da9abb](https://github.com/c4dhi/STELLA/commit/4da9abb42ba8b7e1e58ad7720cfef7621f08d4ad))
* session pagination with timestamp-based cursoring and envelope timestamps ([cbf8767](https://github.com/c4dhi/STELLA/commit/cbf8767b40950b49fa2dfe250c7893cf9ff1237e))
* **sessions:** auto-end on inactivity or max-duration ([#198](https://github.com/c4dhi/STELLA/issues/198)) ([b8c1abc](https://github.com/c4dhi/STELLA/commit/b8c1abc84aa451edd177a7cce3a8a307fd7cca32))
* **sessions:** auto-end on inactivity or max-duration ([#198](https://github.com/c4dhi/STELLA/issues/198)) ([b0043f3](https://github.com/c4dhi/STELLA/commit/b0043f3888a9dc4fb876d21c65ae46cbea83d446))
* **setup:** auto-generate required secrets when not provided ([b45c157](https://github.com/c4dhi/STELLA/commit/b45c15715e995831b3c5aa3e191690ee11f45911))
* **setup:** guide LiveKit internal URL with same-machine IP detection ([2ea2aac](https://github.com/c4dhi/STELLA/commit/2ea2aac0793c6b27d39c6c03cc48dde9e2424ced))
* **setup:** prompt for STELLA_DATA_ROOT and verify PVC storage landed on it ([01b3c6a](https://github.com/c4dhi/STELLA/commit/01b3c6aa465ddc759601758d073ca4b30c06f622))
* **stella-light:** barge-in support at parity with stella-v2 ([8fcbc01](https://github.com/c4dhi/STELLA/commit/8fcbc016c8b8a984d72181498d50b6009d42130f))
* **stella-light:** merge persona + conversation guidelines into one System Prompt ([780961f](https://github.com/c4dhi/STELLA/commit/780961f7e357d5961ae30f468756c845ee798302))
* **stella-light:** move safety guardrails + phase-transition note into editable slots ([80c49dc](https://github.com/c4dhi/STELLA/commit/80c49dc6218053439d139b74ad3f66d173a74911))
* **stella-v2:** deterministic literature-informed verdict responses ([f22b928](https://github.com/c4dhi/STELLA/commit/f22b92844bb4c07719c450911fb7cf11889f7df6))
* **stella-v2:** let the bridge carry the full reaction to cover the gap ([c7899c2](https://github.com/c4dhi/STELLA/commit/c7899c2a4366529861461d8300d00e325998082f))
* **stella-v2:** move response-stage behavioral prose into editable prompt ([cc8fee3](https://github.com/c4dhi/STELLA/commit/cc8fee311de2a0f6eab858aab5111093cddb1b8e))
* **stella-v2:** remove the Input Gate — experts self-gate, arbitration filters ([#363](https://github.com/c4dhi/STELLA/issues/363)) ([d39e24f](https://github.com/c4dhi/STELLA/commit/d39e24fae8871dd3ef715eeb8dcae6a0c1489025))
* **stella-v2:** sharpen per-expert engage/tap-out contracts ([#363](https://github.com/c4dhi/STELLA/issues/363) follow-up) ([da27c55](https://github.com/c4dhi/STELLA/commit/da27c55b095a02ad985d85d66b714b86ef9d03c9))
* **stella-v2:** stream the bridge to TTS through the response interface ([f27328e](https://github.com/c4dhi/STELLA/commit/f27328ea0ff9554b1981bd376feba7fe72719160))
* **stella-v2:** unify prompt context behind one template interface + bridge/response naturalness ([f97cb69](https://github.com/c4dhi/STELLA/commit/f97cb6943127f229a5b684f96f6bee2e367d5ffe))
* **teleprompter:** word-by-word speech highlight on both chat surfaces ([#241](https://github.com/c4dhi/STELLA/issues/241)) ([2bbc4b9](https://github.com/c4dhi/STELLA/commit/2bbc4b93d371c42055f1a41ba05398572460293a))
* **teleprompter:** word-by-word speech highlight on both chat surfaces ([#241](https://github.com/c4dhi/STELLA/issues/241)) ([49a8581](https://github.com/c4dhi/STELLA/commit/49a85817f195be973c81fcf33338269047d02691))
* transcript download mode selector (transcript / + verdicts) ([de4f6f8](https://github.com/c4dhi/STELLA/commit/de4f6f87f2e9f3057886a7d49cee45882b63d86c))
* transcript download picker overlay with per-type checkboxes ([d0b5ea2](https://github.com/c4dhi/STELLA/commit/d0b5ea2a965a5744c5596fcd5afeaccce9883490))
* **tts/qwen3:** default language to Auto (autodetect from input text) ([54381ab](https://github.com/c4dhi/STELLA/commit/54381abae637bb049dbddbb0e57c885b9e7a581e))
* **tts/voxtral:** startup watchdog explains GPU-mem stalls in the log ([87eb44d](https://github.com/c4dhi/STELLA/commit/87eb44d5f7eb50d3409eeebc121eefe63d779a77))
* **tts:** add bitsandbytes 4-bit/8-bit knobs for Voxtral on low-VRAM GPUs ([7557723](https://github.com/c4dhi/STELLA/commit/7557723d6dc32ef4b7eb7e9a5c6de830320b06fa))
* **tts:** add Voxtral 4B as opt-in local TTS provider ([#235](https://github.com/c4dhi/STELLA/issues/235)) ([0c11647](https://github.com/c4dhi/STELLA/commit/0c11647e7eee4f26a9d80667c5d99cf4c15d7ad3))
* **tts:** adopt Qwen3-TTS as new provider ([#235](https://github.com/c4dhi/STELLA/issues/235)) ([2ead2c2](https://github.com/c4dhi/STELLA/commit/2ead2c21840bda48ec31dcee711b005b2d47ba05))
* **tts:** language-aware & per-agent reference voice selection ([#311](https://github.com/c4dhi/STELLA/issues/311)) ([1686e9e](https://github.com/c4dhi/STELLA/commit/1686e9efbaf94e9861644e429d849a9e93e7c455))
* **tts:** language-aware & per-agent reference voice selection ([#311](https://github.com/c4dhi/STELLA/issues/311)) ([1732395](https://github.com/c4dhi/STELLA/commit/1732395845c545fd92b913b5be0340f29780923a))
* **tts:** per-stream voice selection on the language contract ([#214](https://github.com/c4dhi/STELLA/issues/214)) ([c7852ff](https://github.com/c4dhi/STELLA/commit/c7852ffa8d027a21cdbc4ef126ef6e19e13b7726))
* **tts:** replace Voxtral with in-process Qwen3-TTS, single-provider images ([353bf08](https://github.com/c4dhi/STELLA/commit/353bf083c25d195f2fe64b021ebe33b624af711d))
* **tts:** rewrite Voxtral provider to use vllm-omni sidecar ([92b0b38](https://github.com/c4dhi/STELLA/commit/92b0b3887aadd124a11de73727db3f53d21e73ef))
* **tts:** ship the default Stella voice registry with de + en clips ([2a404e6](https://github.com/c4dhi/STELLA/commit/2a404e617830c1a9803d65febf5e90a1c4b39c25))
* **version:** report the deployed version at GET /version ([#486](https://github.com/c4dhi/STELLA/issues/486)) ([302409b](https://github.com/c4dhi/STELLA/commit/302409b392437ec7704ea250e00ca43dcccda8ac))
* **wizard:** combine Voxtral 4bit/8bit prompts into single quantization select ([6fa9ac5](https://github.com/c4dhi/STELLA/commit/6fa9ac58bc28bc691e3de0f3d746cd7035cc14c2))
* **wizard:** expand optional sub-tabs only when operator opts in ([522f19c](https://github.com/c4dhi/STELLA/commit/522f19c7d78c49c2ae27b275c9745a08e364157d))
* **wizard:** make initial admin bootstrap its own skippable chapter ([178a0fd](https://github.com/c4dhi/STELLA/commit/178a0fd4f4a3cb7402e177091f1568ee76aa65d7))
* **wizard:** prompt for HF_TOKEN under Voxtral and pipe it into the Secret ([6022a4c](https://github.com/c4dhi/STELLA/commit/6022a4c1b6163d716b04ea082c337da05468491d))
* **wizard:** show chapter tab bar on top of every section card ([87149eb](https://github.com/c4dhi/STELLA/commit/87149eb87e6264048f1c3fb2252cecd9dc419d32))
* **wizard:** surface Voxtral provider + CC-BY-NC license prompt ([e7f99df](https://github.com/c4dhi/STELLA/commit/e7f99df762e0c8ba1a582f162ae8a23218ee8e14))


### Bug Fixes

* add Back to admin section + propagate wizard env to start-k8s ([108d60e](https://github.com/c4dhi/STELLA/commit/108d60e0b730cf5e0af846ec8bd7b1b39c17fee6))
* address code-review findings across verdict pipeline, prompt compiler, configurator, and config publishing ([08f7158](https://github.com/c4dhi/STELLA/commit/08f715851d70e9164cdb3de32140363952625247))
* address review feedback on k3s containerd resilience ([ef85699](https://github.com/c4dhi/STELLA/commit/ef85699a7abd77e685847a4e0711c7f3f212cd38))
* apply manifest preprocessing to PVCs & update K3S env var handling ([ee6230a](https://github.com/c4dhi/STELLA/commit/ee6230aee9ab081c232ad53ceac2df0d20d33f24))
* auto-complete deliverable-less tasks in goal state completion checks ([ff1c76b](https://github.com/c4dhi/STELLA/commit/ff1c76b4cd60c6a1eb9ff27eb60c349627e0d979))
* **backup:** atomic import, streamed chunked engine, schema-driven tables ([#378](https://github.com/c4dhi/STELLA/issues/378)) ([b88da51](https://github.com/c4dhi/STELLA/commit/b88da510c42a786a3344c276a9cc1635f9c7f1b8))
* **backup:** clear screen between guided-wizard steps ([#378](https://github.com/c4dhi/STELLA/issues/378)) ([c6e0ffc](https://github.com/c4dhi/STELLA/commit/c6e0ffc949f889591bd36fd5510003579daf1269))
* **backup:** preflight the host-side backup deps with a clear npm-install hint ([#378](https://github.com/c4dhi/STELLA/issues/378)) ([e7e98da](https://github.com/c4dhi/STELLA/commit/e7e98daf06387c4b034ca2fe31e77e34e0b5144e))
* **backup:** preflight the whole host helper toolchain before export/restore ([#378](https://github.com/c4dhi/STELLA/issues/378)) ([3ef9db5](https://github.com/c4dhi/STELLA/commit/3ef9db505b2fec42aa29f6694ddfff9a5e10ddff))
* **backup:** source utils.sh so ensure_dir is defined ([#378](https://github.com/c4dhi/STELLA/issues/378)) ([c412356](https://github.com/c4dhi/STELLA/commit/c41235654df1e965d9aa3c5273e76dc911443ca1))
* **backup:** wait for a Ready, Running backend pod before in-pod import ([#378](https://github.com/c4dhi/STELLA/issues/378)) ([8e26df3](https://github.com/c4dhi/STELLA/commit/8e26df35ad79e0c5357d2faf98c622aefbfa646c))
* **barge-in:** address PR [#281](https://github.com/c4dhi/STELLA/issues/281) review — text barge-in serialization & cleanup ([550bda0](https://github.com/c4dhi/STELLA/commit/550bda097d2cd0fc60ad66d51b2578a944d8da7d))
* **barge-in:** decouple client silencing from teleprompter + suspend watchdog ([#15](https://github.com/c4dhi/STELLA/issues/15) [#241](https://github.com/c4dhi/STELLA/issues/241)) ([02edf04](https://github.com/c4dhi/STELLA/commit/02edf041b096a1004efb42da184fc8961bac8c66))
* **barge-in:** silence client audio on interrupt + harden evaluator ([#241](https://github.com/c4dhi/STELLA/issues/241) [#15](https://github.com/c4dhi/STELLA/issues/15)) ([e124c85](https://github.com/c4dhi/STELLA/commit/e124c8548b2a23d159f4f8e26963903d85d74751))
* **build:** only write rebuild checksum after a successful build ([192b528](https://github.com/c4dhi/STELLA/commit/192b5284f8463f8176466607567a46b06a369307))
* **ci:** the prod deployment tag was never actually created ([82447ca](https://github.com/c4dhi/STELLA/commit/82447caca034da242217d3a88c1fcfa047dbf091))
* **ci:** the prod deployment tag was never actually created ([8ea3b60](https://github.com/c4dhi/STELLA/commit/8ea3b60126801e96d288fd1c30b9279bd09dd50b))
* **ci:** unbreak agent-startup-tests and npm ci, and let dependency changes trigger CI ([#475](https://github.com/c4dhi/STELLA/issues/475)) ([8beea96](https://github.com/c4dhi/STELLA/commit/8beea96545bcf40b8c7cfb6525c7926ef31c8eb1))
* **config:** repair deploy/remediation flows for scoped configs ([#240](https://github.com/c4dhi/STELLA/issues/240) [#251](https://github.com/c4dhi/STELLA/issues/251)) ([2503d2d](https://github.com/c4dhi/STELLA/commit/2503d2d4645bec5bbb858aaea2483c55b5e00315))
* **configurator:** drop 'Insert default' button, keep only 'Reset to default' ([#174](https://github.com/c4dhi/STELLA/issues/174)) ([35f1002](https://github.com/c4dhi/STELLA/commit/35f10022c69121751e4541eb1823bb08166be8a7))
* **configurator:** keep expert prompt empty when cleared ([#174](https://github.com/c4dhi/STELLA/issues/174)) ([1f7ac43](https://github.com/c4dhi/STELLA/commit/1f7ac43bfd5a835f6bf4a028d753730b54c03073))
* **configurator:** keep expert prompt empty when cleared ([#174](https://github.com/c4dhi/STELLA/issues/174)) ([4bf2153](https://github.com/c4dhi/STELLA/commit/4bf2153c5f60e1764adbc38ed2e2e4898ae705ca))
* **configurator:** offer {{language}} in the prompt variable palette ([#214](https://github.com/c4dhi/STELLA/issues/214)) ([5c32ed4](https://github.com/c4dhi/STELLA/commit/5c32ed42756f22d6e16b32c51a6d27966be72a84))
* **configurator:** persist empty values across all node/stage fields ([#174](https://github.com/c4dhi/STELLA/issues/174)) ([813dc5f](https://github.com/c4dhi/STELLA/commit/813dc5f75a476a1b39a9f8d44dbf94e77aada59a))
* **configurator:** render default as editable dimmed text in ExpertListEditor ([#174](https://github.com/c4dhi/STELLA/issues/174)) ([0dac1ec](https://github.com/c4dhi/STELLA/commit/0dac1ecd7f589d023b33c58b1de6a7e7ea09211b))
* **configurator:** stop default re-injection in ExpertListEditor ([#174](https://github.com/c4dhi/STELLA/issues/174)) ([ef3c9c4](https://github.com/c4dhi/STELLA/commit/ef3c9c4b67426d5efd3ec68b0d682a5b5a92e6c0))
* **configurator:** stop mislabeling generic prompt hints as 'Bridge Phrase Injection' ([e234d62](https://github.com/c4dhi/STELLA/commit/e234d62d8ea03451b55af55c3a35c10d1293e5ab))
* **cors:** serve frontend from apex domain, derive CORS from frontend URL ([1a1b99a](https://github.com/c4dhi/STELLA/commit/1a1b99a1ef31153e597bdb03de3f9c9e33896463))
* decouple containerd readiness probe from NODE_ENV ([4bbd3fb](https://github.com/c4dhi/STELLA/commit/4bbd3fbc51df09c391a6df2b7e700706e42dddf7))
* **deliverables:** let a correction overwrite an already-collected deliverable ([#278](https://github.com/c4dhi/STELLA/issues/278)) ([3a8a1fc](https://github.com/c4dhi/STELLA/commit/3a8a1fc9a167008680883428b3e621d30a920601))
* **deploy:** allow digits in TTS provider-name parsing ([d00348a](https://github.com/c4dhi/STELLA/commit/d00348a25647cb55e58fb2e516f617a439d34730))
* **deploy:** auto-detect NODE_ENV from configured env file ([183754a](https://github.com/c4dhi/STELLA/commit/183754a61f34be27ef4fa21b76123952cc193f68))
* **deploy:** fall back to /tmp when STELLA_AI_TEMP_DIR isn't writable ([ff820d3](https://github.com/c4dhi/STELLA/commit/ff820d3d32f329d4b7acfd84355d59bb97e7f930))
* **deploy:** recover initial admin from .env.production when bootstrap file is gone ([d32dad8](https://github.com/c4dhi/STELLA/commit/d32dad8e89140971bee03bbf00928a83521dbc16))
* **deploy:** show CUDA/CPU device tag for qwen3 & chatterbox in config summary ([499080b](https://github.com/c4dhi/STELLA/commit/499080b1b2a9f002599513f8404d26d0fd6692b0))
* **deploy:** stop running services after inline reconfigure before redeploying ([506ace9](https://github.com/c4dhi/STELLA/commit/506ace9c175330a0a0cfa3a5923a43511aed0f10))
* **deps:** undo two major bumps that broke the image builds ([#493](https://github.com/c4dhi/STELLA/issues/493)) ([45f7ebb](https://github.com/c4dhi/STELLA/commit/45f7ebbee2b460243e130115c358e44e0660c821))
* **docs-site:** keep the theme toggle on docs pages, hide it on the landing page ([ffbd985](https://github.com/c4dhi/STELLA/commit/ffbd9858b0509ee08e4940c547f4b3d36c475de3))
* emit task-level progress items for tasks without deliverables ([1f6c464](https://github.com/c4dhi/STELLA/commit/1f6c464d4161a4a43ccbd0c91fd14683906bfcf1))
* enable browser AEC to prevent agent from transcribing its own TT… ([501924f](https://github.com/c4dhi/STELLA/commit/501924f341400a316e54cf686636590aebecf6eb))
* enable browser AEC to prevent agent from transcribing its own TTS output. Fix microphone capture constraints so browser-side echo cancellation is enabled, preventing the assistant from transcribing its own TTS playback. ([b2c181d](https://github.com/c4dhi/STELLA/commit/b2c181d3599397ee90413dfe359759c5590e6ac9))
* **env-vars:** prevent silent secret loss when editing a template (PR [#291](https://github.com/c4dhi/STELLA/issues/291) review [#1](https://github.com/c4dhi/STELLA/issues/1)) ([85ac302](https://github.com/c4dhi/STELLA/commit/85ac302d07a43fd19f40dc991637b4104096cdf5))
* **env-vars:** stop empty optional env vars from crashing agents ([97dba1a](https://github.com/c4dhi/STELLA/commit/97dba1a77456a8586525f8b158f09ad601521f64))
* **env-vars:** template-covered required keys no longer block deploy ([a176b56](https://github.com/c4dhi/STELLA/commit/a176b562082a569982f8716f8632813a573349f6))
* extracted duplicated manual env encryption into encryptManualEnvVarsForStorage(), and added fail-fast guard in restartAgent() when project membership is missing, and now pass projectMembership.userId directly ([6bad73e](https://github.com/c4dhi/STELLA/commit/6bad73e9c5f153f9450c9fa5ee7c8ce688a7af29))
* fall back to pre-built image when build/import fails ([219144b](https://github.com/c4dhi/STELLA/commit/219144b185dbdd502046d318de84cc2ecc2eee96))
* filter progress_update messages from chat history on session resume ([1c84d77](https://github.com/c4dhi/STELLA/commit/1c84d77deebffc8aa9dd10ffefa07e010d284d9a))
* fix(env-vars): fail fast when templateId is provided without userId in resolveEnvVars ([2dc6b5c](https://github.com/c4dhi/STELLA/commit/2dc6b5c07c2a7f4d8bbe95bbc188d7319bd688c3))
* fix(webhooks): store manualEnvVarsEncrypted in lastAgentConfig so resumed agents recover manual env vars via resolveEnvVars ([4058fa1](https://github.com/c4dhi/STELLA/commit/4058fa1f8e81411c89b36ef5e9dd81812241dc24))
* **gpu:** auto-install NVIDIA Container Toolkit; detect runtime by binary ([08932ff](https://github.com/c4dhi/STELLA/commit/08932ffea9c2346f4a467e0ab6c7669f59078ba3))
* **gpu:** restore the numpy bound and CUDA pin so GPU images build and run ([#477](https://github.com/c4dhi/STELLA/issues/477)) ([3914323](https://github.com/c4dhi/STELLA/commit/391432390f1781410a90bf83ec143bb1591dc956))
* harden participant event background tasks with tracking and error logging ([a45c89f](https://github.com/c4dhi/STELLA/commit/a45c89f694e798b586989a711e3cad6559a4a9a2))
* harden session-management pod against stale k3s containerd socket ([55cacca](https://github.com/c4dhi/STELLA/commit/55cacca892901bc9f0b00eb954ba4249c77f931d))
* harden session-management pod against stale k3s containerd socket ([#209](https://github.com/c4dhi/STELLA/issues/209)) ([021bc5f](https://github.com/c4dhi/STELLA/commit/021bc5fa381147f4d3d9a6499065d2c3cf41002c))
* include stateById in routeView useMemo dependencies ([1cfc7fb](https://github.com/c4dhi/STELLA/commit/1cfc7fb7a364c04cdb4aa1a5bd665990f621ad21))
* keep K3S env doc comments commented after deploy-time prefix strip ([315de21](https://github.com/c4dhi/STELLA/commit/315de2150f5af72693e69e4f3ce31ab1f8b6ebcc))
* **landing:** clip animation overflow and tighten mobile hero/navbar layout ([9f0bb3b](https://github.com/c4dhi/STELLA/commit/9f0bb3bf582f502d1cab0d9a2ce0b0ed60bfb2c7))
* **landing:** clip horizontal overflow from entrance animations ([5770386](https://github.com/c4dhi/STELLA/commit/57703867737942a752510685e5f837a902165633))
* **landing:** prevent horizontal page overflow on narrow screens ([5a8c56a](https://github.com/c4dhi/STELLA/commit/5a8c56a50fa6fda92d34e277fb4171148ae52ea1))
* **language:** prefer last detected language over default ([#214](https://github.com/c4dhi/STELLA/issues/214)) ([cb97729](https://github.com/c4dhi/STELLA/commit/cb97729770630b07a937f0ec6f4aeee35ade2ecd))
* **light-agent:** address PR [#336](https://github.com/c4dhi/STELLA/issues/336) review nits ([#306](https://github.com/c4dhi/STELLA/issues/306)) ([31b4ff1](https://github.com/c4dhi/STELLA/commit/31b4ff18d7ae763d41137ae70227b52c0de36612))
* **light-agent:** align tool-extraction pass with the spoken reply ([7f3c158](https://github.com/c4dhi/STELLA/commit/7f3c158c699637c75ed4fff9c6784635192eca6b))
* **light-agent:** all-optional states no longer auto-complete ([#291](https://github.com/c4dhi/STELLA/issues/291)) ([2a749a0](https://github.com/c4dhi/STELLA/commit/2a749a0bbb05e415b6b211d95b60b628cdff2cfc))
* **light-agent:** all-optional states no longer auto-complete ([#291](https://github.com/c4dhi/STELLA/issues/291)) ([e74c240](https://github.com/c4dhi/STELLA/commit/e74c2402d775b343e81e6129e5fe98256e75d8b3))
* **light-agent:** harden turn accounting + empty-goal release ([#291](https://github.com/c4dhi/STELLA/issues/291) review) ([ed8e8e3](https://github.com/c4dhi/STELLA/commit/ed8e8e338aff0876808ac53debd39bc24866c4e2))
* **light-agent:** make the Phase-2 extraction directive conservative ([dac06fb](https://github.com/c4dhi/STELLA/commit/dac06fb1283b7eb3f9e79e106771f121058769e7))
* limit goal discovered-insight auto-transition checks to __goal_achieved__ ([aa56223](https://github.com/c4dhi/STELLA/commit/aa56223c083a4ddb163463a56aa27e11fee79d71))
* **naturalness:** avoid TTS-poor "hmm" in German dispreferred-delivery example ([7fabd7d](https://github.com/c4dhi/STELLA/commit/7fabd7da50e63014fb59b08d7fc5a9d4521c524f))
* normalize transition condition types on state type change ([ac41162](https://github.com/c4dhi/STELLA/commit/ac411620f27e6d9b666ac571178d570b18771ba2))
* **port-forwards:** actually detach in daemon mode ([3427683](https://github.com/c4dhi/STELLA/commit/34276830379c750e9687f48c572733f0033649e3))
* **port-forwards:** actually detach in daemon mode ([8e79b12](https://github.com/c4dhi/STELLA/commit/8e79b12cdfaa6c3e167bf08a11b018602deb779d))
* **port-forwards:** escape the Actions runner process sweep ([983cec5](https://github.com/c4dhi/STELLA/commit/983cec5333a5df782170980ecad1f9f4b9e81122))
* **port-forwards:** escape the Actions runner process sweep ([d9c6d52](https://github.com/c4dhi/STELLA/commit/d9c6d525aef48b66b1f448193f0dc158780115f7))
* preserve legacy transition condition types via existing-option fallback ([0154fe1](https://github.com/c4dhi/STELLA/commit/0154fe18ba031567ff1a8baa51fa19f73ab52622))
* prevent arrow key navigation crash in wizard menus ([08edea9](https://github.com/c4dhi/STELLA/commit/08edea9e3eb0548afdc93cbbefbcff7ec36e8fc3))
* prevent horizontal page overflow on narrow screens ([1603820](https://github.com/c4dhi/STELLA/commit/1603820dec6c59e0bfc5e2562a9b32064eb5e90e))
* prevent STT stall when audio track ends or participant mutes ([44fc6ee](https://github.com/c4dhi/STELLA/commit/44fc6ee559e9a6dc1aa5dd83ea25098664165c07)), closes [#165](https://github.com/c4dhi/STELLA/issues/165)
* **progress:** unify task/skip status across backend, agents, and frontend ([#291](https://github.com/c4dhi/STELLA/issues/291)) ([fbb019b](https://github.com/c4dhi/STELLA/commit/fbb019bdbb3cf6fbb81fa559ab3b6e199527d421))
* **progress:** well-formed last_updated for timezone-aware now ([#310](https://github.com/c4dhi/STELLA/issues/310) review) ([342ddf6](https://github.com/c4dhi/STELLA/commit/342ddf6fa529995a6c4c971f3acfb05a69d75f02))
* refactor: move env var resolution out of KubernetesService into AgentsService via resolveEnvVars() ([66a79fd](https://github.com/c4dhi/STELLA/commit/66a79fde97071439f84e24d1c8d9abf5754b3b20))
* refactor: remove buildRuntimeAgentConfig and validateRuntimeConfigForAgentType from PublicProjectsService ([400b7ee](https://github.com/c4dhi/STELLA/commit/400b7eea31b99cd528dd733c7cd8023749c2915f))
* refactor(env-vars): remove unused encryptedManual from resolveEnvVars return type ([071445a](https://github.com/c4dhi/STELLA/commit/071445a5d2f7722943664f8d55f5710d20c5d02d))
* refactor(public-projects): extract buildRuntimeAgentConfig to remove duplicated config mapping ([386f920](https://github.com/c4dhi/STELLA/commit/386f920c13b36e29c503fc360872cf735c36d4f2))
* remove duplicate getTranscriptMessageTypes implementation ([4ce4f96](https://github.com/c4dhi/STELLA/commit/4ce4f9684c3e6c8d22ec7101584967627e675ff9))
* repo-relative path ([a56a593](https://github.com/c4dhi/STELLA/commit/a56a593d4e683bce3fac457ab3ce587eac0e374d))
* **review:** de-ambiguate chunking + verdict-driven re-anchor ([#304](https://github.com/c4dhi/STELLA/issues/304) review) ([a9be167](https://github.com/c4dhi/STELLA/commit/a9be167b214153dd43838fcac51179d7bd4d044a))
* **runner:** first-wins session_completed metadata on multi-tool turn ([729d549](https://github.com/c4dhi/STELLA/commit/729d549c86db50f5a8ce56c7dbca56ab3b097d1e))
* **sdk:** batch_update keeps its pending snapshot in sync; refresh stale stella-agent comments (PR [#291](https://github.com/c4dhi/STELLA/issues/291) review [#6](https://github.com/c4dhi/STELLA/issues/6),9) ([bdce96a](https://github.com/c4dhi/STELLA/commit/bdce96a3a1ae9d7fd62057cb2683291b8a614051))
* **sdk:** teleprompter highlight trailed the streamed bridge — emit the 'speaking' anchor ahead of its audio ([d147d2b](https://github.com/c4dhi/STELLA/commit/d147d2bb7ed99b7eb9a2413ffde9306a01f17b16))
* **sdk:** use package-relative import in tts_pb2_grpc ([b9f4433](https://github.com/c4dhi/STELLA/commit/b9f44332afa9cb0ed555c6d7e97520cf9feda4f5))
* **seed:** correct seed path and fail deploy when seeding fails ([35357ce](https://github.com/c4dhi/STELLA/commit/35357cea2bc205300d9ba52f61f84d0ee7f3055f))
* **seed:** emit the compiled seed where db:seed actually looks for it ([1f365bf](https://github.com/c4dhi/STELLA/commit/1f365bff3c98882fcd33a1a548365f7fd0326981))
* **session-view:** default debug messages toggle to off ([448215f](https://github.com/c4dhi/STELLA/commit/448215fde955845dcc6101675fa6091f2a079ec9))
* **sessions:** address PR [#198](https://github.com/c4dhi/STELLA/issues/198) review — countdown drift, double-close, wrap-up bounds ([9ab0bb6](https://github.com/c4dhi/STELLA/commit/9ab0bb600f89eb7c032d99e38a5a2e72753ae95c))
* **sessions:** re-anchor + re-arm cap on mid-session change (PR [#198](https://github.com/c4dhi/STELLA/issues/198) review [#3](https://github.com/c4dhi/STELLA/issues/3)) ([6088e99](https://github.com/c4dhi/STELLA/commit/6088e9993acb332dd1c3e39dedba7d1cc1f308a1))
* **setup:** redraw frame + keep progress tabs in guided LiveKit step ([d1c08e9](https://github.com/c4dhi/STELLA/commit/d1c08e962a483058889ee1dd4751b861b85ce60b))
* **state-machine:** a task can't be completed before its required deliverables exist ([77ddc55](https://github.com/c4dhi/STELLA/commit/77ddc55911837b0b912e4a2dd4ff03f809038c19))
* **state-machine:** address PR [#291](https://github.com/c4dhi/STELLA/issues/291) review — hybrid-aware getPendingTasks + spec/type cleanup ([28a637a](https://github.com/c4dhi/STELLA/commit/28a637afe029efa63d360677e4b9c05ead28c88d))
* **state-machine:** don't skip all-optional states; advance them on a turn fallback ([#172](https://github.com/c4dhi/STELLA/issues/172)) ([a7cf327](https://github.com/c4dhi/STELLA/commit/a7cf32770b6ffa81b67defaf11b4be74e06c2fc7))
* **state-machine:** don't skip all-optional states; advance them on a turn fallback ([#172](https://github.com/c4dhi/STELLA/issues/172)) ([c0264fa](https://github.com/c4dhi/STELLA/commit/c0264fa6425bd713166ed1a39f9f0b813519425f))
* **state-machine:** reset in-memory turn counter on transition; surface turn-driven farewell ([4ad0e64](https://github.com/c4dhi/STELLA/commit/4ad0e64024c0ee049cec2eb8462ac571902e94e3))
* **state-machine:** serialize per-session mutations + route-aware auto-advance; consolidate light agent to tools-only ([#291](https://github.com/c4dhi/STELLA/issues/291)) ([5cd9d42](https://github.com/c4dhi/STELLA/commit/5cd9d42a2f47812ac8803eed3aef2afec07b2d6b))
* **stella-light:** match the user's language; bilingual register (German support) ([3e5ac9d](https://github.com/c4dhi/STELLA/commit/3e5ac9d122cdaee84e6a52d39370f8185e4766cb))
* **stella-light:** stop re-confirming the answer the user just gave ([#304](https://github.com/c4dhi/STELLA/issues/304)) ([fe6c9ff](https://github.com/c4dhi/STELLA/commit/fe6c9ffe42fe70973c333d4729760195dfbe7497))
* **stella-v2:** guarantee bridge continuation in code, killing the double bridge ([762789d](https://github.com/c4dhi/STELLA/commit/762789da9e2c17582977323545ae981169419f87))
* **stella-v2:** re-anchor response to post-transition state mid-turn ([345373e](https://github.com/c4dhi/STELLA/commit/345373ed1e6e384284319a662cd392a67f692256))
* stop system namespace error ([6362ba6](https://github.com/c4dhi/STELLA/commit/6362ba656f5ae340bd5068bbb34616bc66ae9362))
* **teleprompter:** continue the speech cursor on a rejected barge-in ([#241](https://github.com/c4dhi/STELLA/issues/241)) ([7a15c08](https://github.com/c4dhi/STELLA/commit/7a15c08327cb702109b5aba3f7d3ee1e12ba9059))
* The restart flow failed at the PostgreSQL step because readiness used a pod label selector (app=postgres), which included stale Completed pods. kubectl wait then timed out waiting for those terminal pods to become Ready, even though the active postgres pod was healthy. This creates problems when starting the app. Its fixed ([3776e0a](https://github.com/c4dhi/STELLA/commit/3776e0a80423535e5e6a32c747904bf48b2c2017))
* transcript chunk ([8fb9834](https://github.com/c4dhi/STELLA/commit/8fb98343844c8c0d2342b08b72df4dca2586fd93))
* **tts/qwen3:** only allow voice-clone-capable models; fail loudly otherwise ([a6d2282](https://github.com/c4dhi/STELLA/commit/a6d2282919bef7d2c2a5f9fcf947c74fe36ab568))
* **tts/voxtral:** coherent vllm-omni stack + correct serve command ([80a0e27](https://github.com/c4dhi/STELLA/commit/80a0e277c7c9dc5f2f00a0271d7bef6c28dfeb8a))
* **tts/voxtral:** default GPU mem util 0.85 -&gt; 0.35 (2-stage model stalls) ([e636125](https://github.com/c4dhi/STELLA/commit/e6361258298a580e54bc620cebb355f2c6a8bae9))
* **tts/voxtral:** per-stage GPU memory split (fixes stage-1 OOM) ([1aa48ed](https://github.com/c4dhi/STELLA/commit/1aa48ed32c27fdf783139768fd1882fc27cf6a19))
* **tts/voxtral:** set GPU mem util default to 0.5, confirm wizard wiring ([d7cf76b](https://github.com/c4dhi/STELLA/commit/d7cf76b98180be8c9edcbdd3e3950dd783ed4c78))
* **tts/voxtral:** use python3 in build smoke test (no bare python in base) ([d85548a](https://github.com/c4dhi/STELLA/commit/d85548a338d1a86f7c916c1c72d793a7393a6689))
* **tts:** address PR [#312](https://github.com/c4dhi/STELLA/issues/312) review — drop SDK proto drift, align cache windows ([7ce1bce](https://github.com/c4dhi/STELLA/commit/7ce1bce9efd122b66252f0556b15a4708dde2eaf))
* **tts:** normalize language labels and fall back to autodetect in Qwen3 ([c60d5e2](https://github.com/c4dhi/STELLA/commit/c60d5e2b473953f28bf26baf2bd8d16040f77fad))
* **tts:** report actual TTS provider and surface mismatch with logs ([99406bd](https://github.com/c4dhi/STELLA/commit/99406bdbf2022534e9b2bce54ecf7e60b0b6f14b))
* **tts:** stop stream leaks/drops on barge-in, guarantee is_final, fix qwen3 memory (PR [#291](https://github.com/c4dhi/STELLA/issues/291) review [#2](https://github.com/c4dhi/STELLA/issues/2)-5,9) ([b17e399](https://github.com/c4dhi/STELLA/commit/b17e3992ebd71996dd9e93afe5eb17c2a930573e))
* tune Silero VAD and handle transcript_chunk messages ([5449f5c](https://github.com/c4dhi/STELLA/commit/5449f5c33c43035f91cd2a023f98b913f0630f65))
* upgrade audio output check to real-time round-trip test ([cb401d6](https://github.com/c4dhi/STELLA/commit/cb401d62dd7d1db40073a1eb4f938997d3576038))
* validate imported plans and migrate node layout metadata to metadata.nodePositions ([c9f3336](https://github.com/c4dhi/STELLA/commit/c9f3336b11113b056cff6675c87dd3b7384753a7))
* **webhooks:** re-activate closed/closing session when a human rejoins ([6289fda](https://github.com/c4dhi/STELLA/commit/6289fdac57310fa33975c2e1b30c31f01a83c1c2))
* **wizard:** honor skip and suggest correct start command for production ([310851f](https://github.com/c4dhi/STELLA/commit/310851f181ad6758312ac8e6537592c5929acbd7))
* **wizard:** preserve unknown variables across save ([8a012e5](https://github.com/c4dhi/STELLA/commit/8a012e5bc2fa2ba9090f14066fb7f8ff0850cd35))
* **wizard:** skip ElevenLabs vars when TTS_PROVIDER is not elevenlabs ([bac01ea](https://github.com/c4dhi/STELLA/commit/bac01ea7191e467beecfd4265fe79de348ab0e61))
* **wizard:** use explicit 'auto' option for VOXTRAL_DTYPE select ([a3aed73](https://github.com/c4dhi/STELLA/commit/a3aed736b331630a4183812b527691fe2174e543))


### Performance Improvements

* **build:** scope the rebuild checksum, and stop deleting the build cache ([#485](https://github.com/c4dhi/STELLA/issues/485)) ([f9e0acd](https://github.com/c4dhi/STELLA/commit/f9e0acd92ffb673e471b4db11c64c0c304398a06))
* **live-session:** address [#305](https://github.com/c4dhi/STELLA/issues/305) review — agentConfig compare, rAF stop race, tests ([69fcbdc](https://github.com/c4dhi/STELLA/commit/69fcbdcd5bdca726531d2ccc362fcc9c865fd719))
* **live-session:** stop idle CPU burn — audio-level re-render storm + redundant polling ([#305](https://github.com/c4dhi/STELLA/issues/305)) ([aa30e44](https://github.com/c4dhi/STELLA/commit/aa30e44d0e2721da724e254cd328e7b4f8eb173a))
* **live-session:** stop idle CPU burn from audio-level storm + redundant polling ([#305](https://github.com/c4dhi/STELLA/issues/305)) ([db2e893](https://github.com/c4dhi/STELLA/commit/db2e893efc79c8b7f29533e41adb8e2af2aad0ca))
* **stt:** take language detection free from auto-detect, drop probe ([#214](https://github.com/c4dhi/STELLA/issues/214)) ([f400631](https://github.com/c4dhi/STELLA/commit/f400631c1f88852157517e344ed031deaae58f84))
* **tts/chatterbox:** cut TTFB via warm-up, autocast, chunk pipelining ([0333921](https://github.com/c4dhi/STELLA/commit/03339212807e0da8686eb5931ff55ed8b253ee37))
* **tts:** apply chunk-pipelined streaming + warm-up to all providers ([05c730d](https://github.com/c4dhi/STELLA/commit/05c730d3ef3d68e6b3a7d1be0df577366815f003))


### Reverts

* **light-agent:** drop the Phase-2 reply-injection + directive ([#1](https://github.com/c4dhi/STELLA/issues/1)) ([63711bb](https://github.com/c4dhi/STELLA/commit/63711bbcca61d988f7b3f8bb117f1e062bda9d4a))

## [Unreleased]

### Added

**stella-v2 Agent**
- stella-v2 agent with streamlined 5-stage pipeline: Input Gate, Expert Pool, Deterministic Arbitration, Response Generator, Bridge Generator
- Visual Pipeline Configurator for creating and managing pipeline configurations
- Pipeline configuration management (create, edit, duplicate, delete) with sparse override pattern
- Mandatory pipeline configuration selection for stella-v2 deployment
- Bridge Generator for reduced perceived latency in voice conversations
- gRPC State Machine integration for decoupled conversation flow management
- Documentation for stella-v2 architecture, pipeline configurator, and schema reference

---

## [0.3.0] - 2026-01-29

### Added

**Participant Experience**
- Text-only interface for participant screen (#24)
- Marketing landing page (#12)
- Mobile-ready participant screen with responsive design (#25)
- Session transcript export functionality (#50)
- Public web interface for interviewees (#3)

**Agent & System Capabilities**
- Agent Toolkit/Toolbox implementation for extensible agent capabilities (#20)
- Enhanced Conversational Agent with improved dialogue handling (#88)
- Whisper integration for Text-to-Speech (#7)
- Public Projects feature for shared access (#4)
- Environment variable override support in DeployAgentModal

**Project & User Management**
- Per-user project basis with sharing capabilities (#34)
- Environment Variable Templates for Agent Types (#28)
- System-wide state persistence (#31)

**Documentation & Onboarding**
- Adaptive documentation system (#29)
- Dynamic onboarding through start-script (#56)
- Custom Tools guide for extending agent capabilities
- Database Schema documentation with complete Prisma model reference
- Custom Agent Visualizers guide for creating face visualizers
- Environment Variables reference documentation
- Message Recording deployment guide
- Authentication guide with JWT implementation details

### Changed
- Refactored Conversational AI Agent to SDK architecture (#10)
- Migrated system from Minikube to K3S with enforced microservice architecture for STT and TTS (#14)
- Improved start script and repository structure (#16)
- Improved code block styling with automatic word wrapping
- Updated architecture overview with database references
- Enhanced cross-linking between documentation pages

### Fixed
- Fixed Whisper warmup functions not existing (#70)
- Fixed Whisper not reliably transcribing speech (#49) [P0]
- Fixed double texting issue (#9)
- Fixed new user error when no projects exist (#36)
- Fixed initial message bug (#6)
- Fixed unselecting Debug in Session Overview not working (#11)
- Fixed environment variables not reaching agent pods when modified in deploy modal
- Fixed LiveKit Production page title formatting

---

## [0.2.0] - 2026-01-17

### Added
- Complete documentation site with Docusaurus
- Getting Started guides (Quick Start, Installation, First Agent)
- Architecture documentation (Overview, Data Flow, Session Lifecycle, Kubernetes)
- SDK Reference (Overview, Base Agent, Plans, Tools, Streaming, TypeScript Types)
- Deployment guides (Kubernetes, Nginx, Production Checklist)
- LiveKit integration documentation
- Contributing guidelines (Development Setup, Coding Standards, PR Process)
- Plan Structure documentation with state machine details

### Changed
- Migrated documentation from standalone markdown files to Docusaurus
- Reorganized documentation structure for better navigation

---

## [0.1.0] - 2026-01-10

### Added
- Initial STELLA backend release
- NestJS-based session management server
- LiveKit integration for real-time audio/video
- PostgreSQL database with Prisma ORM
- Kubernetes orchestration for agent pods
- STELLA Agent SDK for Python agents
- State machine for conversation flow management
- React frontend with visualizer gallery
- JWT-based authentication system
- Project and session management APIs

---

[Unreleased]: https://github.com/c4dhi/STELLA/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/c4dhi/STELLA/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/c4dhi/STELLA/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/c4dhi/STELLA/releases/tag/v0.1.0
