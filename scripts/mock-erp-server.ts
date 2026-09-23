import { pathToFileURL } from 'node:url';
import { mockERP } from '../src/mock-erp.js';

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const port=Number(process.env.MOCK_ERP_PORT??3211);
  if(!Number.isInteger(port) || port<1 || port>65535) throw Error('INVALID_MOCK_ERP_PORT');
  const mock=await mockERP(port);
  console.log(`Fictional ERPNext-compatible mock: ${mock.url}`);
  process.once('SIGINT',()=>{void mock.close();});
}
