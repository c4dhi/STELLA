import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// @testing-library/react normally registers this itself, but only when
// `afterEach` is a real global — this project doesn't set `test.globals:
// true`, so every file that renders a hook/component and never unmounts it
// leaks whatever effects that teardown would have run (a pending
// requestAnimationFrame or setInterval, in particular) past the end of the
// test, which can throw "window is not defined" from unrelated code if the
// worker running that file is later reused for another one (#987).
afterEach(cleanup)
