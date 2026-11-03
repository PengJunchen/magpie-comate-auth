// Handwritten public-interface contracts and synthetic data only.
export const define=(name,properties,required=[])=>({type:'function',function:{name,parameters:{type:'object',properties,required,additionalProperties:false}}})
export const contracts=[
  define('read',{path:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},['path']),
  define('ls',{path:{type:'string'},all:{type:'boolean'},long:{type:'boolean'},sort:{type:'string',enum:['','name','time','size']}}),
  define('find',{path:{type:'string'},pattern:{type:'string'},type:{type:'string',enum:['','f','d']},max_depth:{type:'integer',minimum:0}}),
  define('grep',{path:{type:'string'},pattern:{type:'string'},glob:{type:'string'}},['pattern']),
  define('bash',{command:{type:'string'},timeout_ms:{type:'integer'}},['command']),
  define('write',{path:{type:'string'},content:{type:'string'},append:{type:'boolean'}},['path','content']),
  define('edit',{file_path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'}},['file_path','old_string','new_string']),
]

export const mappingCases=[
  ['read',{target_file:'scratch/file.txt',offset:'2',limit:'4'},{path:'scratch/file.txt',offset:2,limit:4}],
  ['ls',{target_directory:'scratch',all:'true',long:'false',sort:'name'},{path:'scratch',all:true,long:false,sort:'name'}],
  ['find',{target_directory:'scratch',depth:'2',pattern:'*.txt',type:'f'},{path:'scratch',max_depth:2,pattern:'*.txt',type:'f'}],
  ['grep',{target_directory:'scratch',search_query:'needle',include:'*.txt'},{path:'scratch',pattern:'needle',glob:'*.txt'}],
  ['bash',{cmd:'printf fixture',timeoutMs:'1000'},{command:'printf fixture',timeout_ms:1000}],
  ['write',{target_path:'scratch/file.txt',content:'[]',append:'false'},{path:'scratch/file.txt',content:'[]',append:false}],
  ['edit',{target_file:'scratch/file.txt',old_string:'old',new_string:'new'},{file_path:'scratch/file.txt',old_string:'old',new_string:'new'}],
]
