// Replaces the department master for My Need Mart (RET6978) with the rows
// from MasterRetailDB.departmentmasters.csv.
//
// The old departments are deleted first (per the export's own project_code,
// though in practice the whole 'departmentmasters' collection in
// MyNeedMart_DB belongs to this tenant), then the CSV rows are inserted.
//
//   node scripts/update_myneedmart_departments.js
//   node scripts/update_myneedmart_departments.js --file /path/to/other.csv
//   node scripts/update_myneedmart_departments.js --dry-run

require('dotenv').config();
const fs = require('fs');

const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');
require('../models/Department'); // registers the schema for getTenantDb()

const PROJECT_CODE = 'RET6978';
const DEFAULT_CSV_PATH = '/Users/gauravpawar/Downloads/Universal_Setup/MasterRetailDB.departmentmasters.csv';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const dryRun = process.argv.includes('--dry-run');

// Minimal CSV parser — fine here since this export has no quoted/escaped
// commas in any field.
const parseCsv = (text) => {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((header, i) => { row[header] = cells[i]; });
    return row;
  });
};

const toDepartment = (row) => ({
  department_id: row.department_id,
  department_name: row.department_name,
  dept_type_id: row.dept_type_id,
  dept_no_of_col: Number(row.dept_no_of_col) || 0,
  store_code: row.store_code === 'null' ? null : row.store_code,
  image_link: row.image_link === 'null' ? undefined : row.image_link,
  sequence_id: Number(row.sequence_id),
  project_code: row.project_code,
});

const run = async () => {
  const csvPath = arg('file') || DEFAULT_CSV_PATH;
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const departments = rows.map(toDepartment);

  console.log(`📄 Parsed ${departments.length} department(s) from ${csvPath}`);

  await connectDB();

  const project = await getProjectModel().findOne({ project_code: PROJECT_CODE }).lean();
  if (!project) throw new Error(`No project found for ${PROJECT_CODE}`);

  const db = getTenantDb(project.db_name);
  const Department = db.models.Department;

  const existing = await Department.countDocuments({});
  console.log(`🗑  ${existing} existing department(s) in ${project.db_name} will be deleted`);

  if (dryRun) {
    console.log('🔍 Dry run — no writes. New rows would be:');
    departments.forEach((d) => console.log(`   ${d.department_id}. ${d.department_name} (seq ${d.sequence_id})`));
    await disconnectDB();
    return;
  }

  const deleteResult = await Department.deleteMany({});
  console.log(`   deleted ${deleteResult.deletedCount}`);

  const inserted = await Department.insertMany(departments, { ordered: true });
  console.log(`✔ Inserted ${inserted.length} department(s) into ${project.db_name}:`);
  inserted.forEach((d) => console.log(`   ${d.department_id}. ${d.department_name} (seq ${d.sequence_id})`));

  await disconnectDB();
};

run().catch((err) => {
  console.error('Update failed:', err.message);
  process.exit(1);
});
