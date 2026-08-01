/** CLI test for DeepSeek client: npm run test:ai */
import { runAllTests } from './deepseek-client';

runAllTests().then(r => {
  console.log(r.allPassed ? '✅ All tests passed' : '❌ Some tests failed');
  console.log(JSON.stringify(r.results, null, 2));
  if (!r.allPassed) process.exit(1);
}).catch(err => { console.error(err); process.exit(1); });
