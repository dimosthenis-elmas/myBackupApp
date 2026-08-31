  import {SelectionModel} from '@angular/cdk/collections';
  import {FlatTreeControl} from '@angular/cdk/tree';
  import {Component, Injectable, Input} from '@angular/core';
  import {MatTreeFlatDataSource, MatTreeFlattener} from '@angular/material/tree';
  import {BehaviorSubject} from 'rxjs';
  
  /**
   * Node for to-do item
   */
  export class TodoItemNode {
    children!: TodoItemNode[];
    item!: string;
    // optional, extra data associated with the item.
    extras: any;
  }
  
  /** Flat to-do item node with expandable and level information */
  export class TodoItemFlatNode {
    item!: string;
    level!: number;
    expandable!: boolean;
    // optional, extra data associated with the item.
    extras: any;
  }
  
  /** Converts an array of strings (file paths) to a json object readable by angular's mat-tree.
   * @param files an array of strings (paths to a file or empty_folder). Example ['1.txt', 'folder1\2.txt', 'folder1\3.txt', 'folder1\empty_folder\', 'folder1\empty_folder1\empty_folder2\', '4.txt']
   * @return a json object that can be used in an angular mat-tree. Example {"1.txt":null, folder1:{"2.txt":null, "3.txt":null, empty_folder:{}, empty_folder1:{empty_folder2:{}}}, "4.txt":null}
   */
  const list_to_json_ = function(files: any[]){
    let root = {};
    files.forEach(function(file){
      let tokens = file.split('\\');
      let head:any = root;
      let lastTokenIndex = tokens.length-1;
      // Inform the "root" object about the directory structure that leads to this "file" (or "empty folder")
      for(let i=0; i<lastTokenIndex; ++i){
        if(!head.hasOwnProperty(tokens[i])){
          // Create property for this folder
          head[tokens[i]] = {};
        }
        // "cd" to this folder 
        head = head[tokens[i]];
      }
      // You reached the bottom! Is it a "file" or an "empty folder"
      if(tokens[lastTokenIndex] != ''){
        // It was a file!
        head[tokens[lastTokenIndex]] = null;
      }
    });
    return root;
  }

  // New version including Extras (additional info not displayed, but retained in the 'database')
  const list_to_json = function(files: any[], extras: any[] = []){
    let root = {};
    files.forEach(function(file, index){
      let tokens = file.split('\\');
      let head:any = root;
      let lastTokenIndex = tokens.length-1;
      // Inform the "root" object about the directory structure that leads to this "file" (or "empty folder")
      for(let i=0; i<lastTokenIndex; ++i){
        if(!head.hasOwnProperty(tokens[i])){
          // Create property for this folder

          // Extras is optional ..
          let e: any = null;
          if(extras.length > 0){
            e = extras[index];
          }
          head[tokens[i]] = {"children":{}, "extras": e};
        }
        // "cd" to this folder 
        head = head[tokens[i]].children;
      }
      // You reached the bottom! Is it a "file" or an "empty folder"
      if(tokens[lastTokenIndex] != ''){
        // It was a file!

        // Extras is optional ..
        let e: any = null;
        if(extras.length > 0){
          e = extras[index];
        }
        head[tokens[lastTokenIndex]] = {"children": null, "extras": e};
      }
    });
    return root;
  }

  /**
   * Checklist database, it can build a tree structured Json object.
   * Each node in Json object represents a to-do item or a category.
   * If a node is a category, it has children items and new items can be added under the category.
   */
  @Injectable()
  export class ChecklistDatabase {
    dataChange = new BehaviorSubject<TodoItemNode[]>([]);

    /** The current file/folder tree, as a nested JSON object (see list_to_json). Used to be a module-level
     *  variable (TREE_DATA) shared across every ChecklistDatabase/FilesTreeComponent instance in the whole
     *  app - harmless only because every current caller happens to await setTreeData() sequentially (see
     *  backup-to-optical-media.component.ts's createTrees, the one place with multiple simultaneous
     *  <files-tree> instances on screen at once), but a real landmine for any future concurrent usage: two
     *  trees calling setTreeData around the same time would race on the same shared variable. Now scoped to
     *  this instance instead, matching how ChecklistDatabase itself is already instantiated per-component
     *  (see the `providers: [ChecklistDatabase]` on FilesTreeComponent's @Component decorator). */
    private treeData: any = {};

    get data(): TodoItemNode[] { return this.dataChange.value; }

    constructor() {
      this.initialize();
    }

    /** Replaces this instance's tree data and rebuilds the displayed tree from it - see
     *  FilesTreeComponent.setTreeData, the only caller. */
    async setTreeData(treeData: any): Promise<void> {
      this.treeData = treeData;
      await this.initialize();
    }

    async initialize() {
      // Build the tree nodes from Json object. The result is a list of `TodoItemNode` with nested
      //     file node as children.
      const data = await this.buildFileTree(this.treeData, 0);
      this.dataChange.next(data);

    }
  
    /**
     * Build the file structure tree. The `value` is the Json object, or a sub-tree of a Json object.
     * The return value is the list of `TodoItemNode`.
     * 
     * This is the old version of buildFileTree. Because this function is synchronous we created an async
     * version of it. Please also read the comment on buildFileTree for an explanation on why we needed something like this. 
     */
    buildFileTree_(obj: {[key: string]: any}, level: number): TodoItemNode[] {
      return Object.keys(obj).reduce<TodoItemNode[]>((accumulator, key) => {
        const value = obj[key];
        const node = new TodoItemNode();
        node.item = key;
  
        if (value != null) {
          if (typeof value === 'object') {
            node.children = this.buildFileTree_(value, level + 1);
          } else {
            node.item = value;
          }
        }
  
        return accumulator.concat(node);
      }, []);
    }

    async buildFileTree(obj: {[key: string]: any}, level: number, accumulator: TodoItemNode[] = []): Promise<TodoItemNode[]>{
      for (const [key, value] of Object.entries(obj)) {
        const node = new TodoItemNode();
        node.item = key;
        node.extras = value.extras;

        
        if (value.children != null) {
          if (typeof value === 'object') {
            node.children = await this.buildFileTree(value.children, level + 1, []);
            node.extras = value.extras;
          } else {
            node.item = value;
          }
        }
  
        //Push instead of concat, more efficient (per AI)
        accumulator.push(node);
      }
      /* This is necessary in order for the UI to not freeze.
      This function is going to occupy the single thread for some time.
      By setting a timeout we give the chance for other stuff (like the user pressing the cancel button)
      to be processed. Because we also need this function to finish in a shorter period of time we run this
      timeout only 10% of the iterations or something.
      Note that this is still not an elegant solution and we must (in a future version) try to offload the conputation
      done here to the worker process. But for now, it is what it is.
      */
      const prob = 0.2
      if(Math.random() < prob){
        //Only way (as far as I understand) to make buildFileTree function blocking is to use an await. 
        await this.holdOn(); 
      }
      return accumulator;
    }

    holdOn = () => {
      return new Promise<void>(resolve =>
        setTimeout(() => {
          resolve();
        },0)
      );
    }
  
    /** Add an item to to-do list */
    insertItem(parent: TodoItemNode, name: string) {
      if (parent.children) {
        parent.children.push({item: name} as TodoItemNode);
        this.dataChange.next(this.data);
      }
    }
  
    updateItem(node: TodoItemNode, name: string) {
      node.item = name;
      this.dataChange.next(this.data);
    }
  }
  
  /**
   * @title Tree with checkboxes
   */
  @Component({
    selector: 'files-tree',
    templateUrl: './files-tree.component.html',
    styleUrls: ['./files-tree.component.scss'],
    providers: [ChecklistDatabase]
  })
  export class FilesTreeComponent {
    /** When true, selecting (or deselecting) one part of a large file that was split across multiple pieces
     *  (see PART_FILE_PATTERN below) automatically selects/deselects every OTHER part of that same file too -
     *  so recovering a file split into many pieces (possibly across several discs) only takes one click instead
     *  of one click per part. Only ever meaningful in a recovery context - split-file naming
     *  ("<name>.part.<digits>") only ever shows up there, never in a backup-direction file picker, so this is a
     *  harmless no-op wherever it's left false (the default, for every <files-tree> usage that doesn't opt in). */
    @Input() groupPartialFiles = false;

    /** Matches this app's own large-file split volume naming convention - see PART_FILE_PATTERN in
     *  app/workers/worker.ts and groupSelectedPartialFiles in optical-disc-backup-data-retriever.component.ts,
     *  which this mirrors exactly (kept as its own copy here since this component doesn't otherwise depend on
     *  that one). */
    private static readonly PART_FILE_PATTERN = /^(.+)\.part\.\d+$/i;

    /** Map from flat node to nested node. This helps us finding the nested node to be modified */
    flatNodeMap = new Map<TodoItemFlatNode, TodoItemNode>();
  
    /** Map from nested node to flattened node. This helps us to keep the same object for selection */
    nestedNodeMap = new Map<TodoItemNode, TodoItemFlatNode>();
  
    /** A selected parent node to be inserted */
    selectedParent: TodoItemFlatNode | null = null;
  
    /** The new item's name */
    newItemName = '';
  
    treeControl: FlatTreeControl<TodoItemFlatNode>;
  
    treeFlattener: MatTreeFlattener<TodoItemNode, TodoItemFlatNode>;
  
    dataSource: MatTreeFlatDataSource<TodoItemNode, TodoItemFlatNode>;
  
    /** The selection for checklist */
    checklistSelection = new SelectionModel<TodoItemFlatNode>(true /* multiple */);
  
    constructor(private _database: ChecklistDatabase) {
      this.treeFlattener = new MatTreeFlattener(this.transformer, this.getLevel,
        this.isExpandable, this.getChildren);
      this.treeControl = new FlatTreeControl<TodoItemFlatNode>(this.getLevel, this.isExpandable);
      this.dataSource = new MatTreeFlatDataSource(this.treeControl, this.treeFlattener);
  
      _database.dataChange.subscribe(data => {
        this.dataSource.data = data;
      });
    }

    async setTreeData(treeData: Array<string>, extras:Array<any>=[]): Promise<void>{
      await this._database.setTreeData(list_to_json(treeData, extras));
    }
  
    getLevel = (node: TodoItemFlatNode) => node.level;
  
    isExpandable = (node: TodoItemFlatNode) => node.expandable;
  
    getChildren = (node: TodoItemNode): TodoItemNode[] => node.children;
  
    hasChild = (_: number, _nodeData: TodoItemFlatNode) => _nodeData.expandable;
  
    hasNoContent = (_: number, _nodeData: TodoItemFlatNode) => _nodeData.item === '';
  
    /**
     * Transformer to convert nested node to flat node. Record the nodes in maps for later use.
     */
    transformer = (node: TodoItemNode, level: number) => {
      const existingNode = this.nestedNodeMap.get(node);
      const flatNode = existingNode && existingNode.item === node.item
          ? existingNode
          : new TodoItemFlatNode();
      flatNode.item = node.item;
      flatNode.extras = node.extras;
      flatNode.level = level;
      flatNode.expandable = (Array.isArray(node.children))
      this.flatNodeMap.set(flatNode, node);
      this.nestedNodeMap.set(node, flatNode);
      return flatNode;
    }
  
    /** Whether all the descendants of the node are selected. */
    descendantsAllSelected(node: TodoItemFlatNode): boolean {
      const descendants = this.treeControl.getDescendants(node);
      const descAllSelected = descendants.every(child =>
        this.checklistSelection.isSelected(child)
      );
      return descAllSelected;
    }
  
    /** Whether part of the descendants are selected */
    descendantsPartiallySelected(node: TodoItemFlatNode): boolean {
      const descendants = this.treeControl.getDescendants(node);
      const result = descendants.some(child => this.checklistSelection.isSelected(child));
      return result && !this.descendantsAllSelected(node);
    }
  
    /** Toggle the to-do item selection. Select/deselect all the descendants node */
    todoItemSelectionToggle(node: TodoItemFlatNode): void {
      this.checklistSelection.toggle(node);
      const descendants = this.treeControl.getDescendants(node);
      this.checklistSelection.isSelected(node)
        ? this.checklistSelection.select(...descendants)
        : this.checklistSelection.deselect(...descendants);
  
      // Force update for the parent
      descendants.every(child =>
        this.checklistSelection.isSelected(child)
      );
      this.checkAllParentsSelection(node);
    }
  
    /** Toggle a leaf to-do item selection. Check all the parents to see if they changed */
    todoLeafItemSelectionToggle(node: TodoItemFlatNode): void {
      this.checklistSelection.toggle(node);
      if (this.groupPartialFiles) {
        this.toggleSiblingPartialFiles(node);
      }
      this.checkAllParentsSelection(node);
    }

    /** When groupPartialFiles is on and `node` is one part of a split large file (PART_FILE_PATTERN), selects
     *  or deselects every OTHER part of that same file to match `node`'s own just-toggled state - e.g. checking
     *  any one of "video.mp4.part.001" .. "video.mp4.part.025" checks the whole set in one click. Siblings are
     *  looked for among the toggled node's own parent's children (via flatNodeMap/nestedNodeMap, or the
     *  top-level nodes if there is no parent) - the app's own split-file convention always puts every part of a
     *  file in the very same folder (see partitionBackupToOpticalMedia in worker.ts), so this is always a
     *  same-parent search, never a whole-tree scan. */
    private toggleSiblingPartialFiles(node: TodoItemFlatNode): void {
      const match = FilesTreeComponent.PART_FILE_PATTERN.exec(node.item);
      if (!match) { return; }
      const baseName = match[1];
      const nowSelected = this.checklistSelection.isSelected(node);

      const parentFlat = this.getParentNode(node);
      const siblingNestedNodes = parentFlat ? (this.flatNodeMap.get(parentFlat)?.children ?? []) : this._database.data;

      for (const nestedSibling of siblingNestedNodes) {
        const siblingFlat = this.nestedNodeMap.get(nestedSibling);
        if (!siblingFlat || siblingFlat === node || siblingFlat.expandable) { continue; }
        const siblingMatch = FilesTreeComponent.PART_FILE_PATTERN.exec(siblingFlat.item);
        if (!siblingMatch || siblingMatch[1] !== baseName) { continue; }
        if (nowSelected) {
          this.checklistSelection.select(siblingFlat);
        } else {
          this.checklistSelection.deselect(siblingFlat);
        }
      }
    }
  
    /* Checks all the parents when a leaf node is selected/unselected */
    checkAllParentsSelection(node: TodoItemFlatNode): void {
      let parent: TodoItemFlatNode | null = this.getParentNode(node);
      while (parent) {
        this.checkRootNodeSelection(parent);
        parent = this.getParentNode(parent);
      }
    }
  
    /** Check root node checked state and change it accordingly */
    checkRootNodeSelection(node: TodoItemFlatNode): void {
      const nodeSelected = this.checklistSelection.isSelected(node);
      const descendants = this.treeControl.getDescendants(node);
      const descAllSelected = descendants.every(child =>
        this.checklistSelection.isSelected(child)
      );
      if (nodeSelected && !descAllSelected) {
        this.checklistSelection.deselect(node);
      } else if (!nodeSelected && descAllSelected) {
        this.checklistSelection.select(node);
      }
    }
  
    /* Get the parent node of a node */
    getParentNode(node: TodoItemFlatNode): TodoItemFlatNode | null {
      const currentLevel = this.getLevel(node);
  
      if (currentLevel < 1) {
        return null;
      }
  
      const startIndex = this.treeControl.dataNodes.indexOf(node) - 1;
  
      for (let i = startIndex; i >= 0; i--) {
        const currentNode = this.treeControl.dataNodes[i];
  
        if (this.getLevel(currentNode) < currentLevel) {
          return currentNode;
        }
      }
      return null;
    }
  
    /** Select the category so we can insert the new item. */
    addNewItem(node: TodoItemFlatNode) {
      const parentNode = this.flatNodeMap.get(node);
      this._database.insertItem(parentNode!, '');
      this.treeControl.expand(node);
    }
  
    /** Save the node to database */
    saveNode(node: TodoItemFlatNode, itemValue: string) {
      const nestedNode = this.flatNodeMap.get(node);
      this._database.updateItem(nestedNode!, itemValue);
    }

    expandAllNodes(){ 
      this.treeControl.dataNodes.forEach((node)=>{
        this.treeControl.expand(node);    
      })
    }
  
    collapseAllNodes(){ 
      this.treeControl.dataNodes.forEach((node)=>{
        this.treeControl.collapse(node);    
      })
    }

    selectAllNodes(){ 
      this.treeControl.dataNodes.forEach((node)=>{
        this.checklistSelection.select(node); 
      })
    }

    deselectAllNodes(){ 
      this.treeControl.dataNodes.forEach((node)=>{
        this.checklistSelection.deselect(node); 
      })
    }

    isEmptyDir(node: TodoItemFlatNode){
      return !this.treeControl.getDescendants(node).length;
    }

    add_folder(folder: string, prefix: any): void {
      prefix.str += folder + "\\";
      ++prefix.level;
    }

    remove_folder(prefix: any): void {
      for (let i = prefix.str.length - 2; i >= 0; --i) {
        if (prefix.str[i] == '\\') {
          prefix.str = prefix.str.substring(0, i + 1);
          --prefix.level;
          return;
        }
      }
      // moving to "root" directory (ex "C\\Users" where the "C" has no "\" before it)
      prefix.str = "";
      --prefix.level;
    }

    getSelectedData(): Array<string> {
      let selectedPaths: Array<string> = [];
      let prefix = { str: "", level: 0 };
      this.treeControl.dataNodes.forEach((node) => {
        let level_difference = prefix.level - node.level;
        if (level_difference > 0) {
          for (let i = 0; i < level_difference; ++i) {
            this.remove_folder(prefix);
          }
          level_difference = prefix.level - node.level;
        }
        if (node.expandable) {
          // "folder"
          if(this.isEmptyDir(node)){
            if (this.checklistSelection.isSelected(node)) {
              //console.log("[selected]:" + prefix.str + node.item + "\\");
              selectedPaths.push(prefix.str + node.item + "\\");
            }
          }else{
            if (level_difference <= 0) {
              this.add_folder(node.item, prefix);
            }
          }
        } else {
          if (this.checklistSelection.isSelected(node)) {
            // "file"
            //console.log("[selected]:" + prefix.str + node.item);
            selectedPaths.push(prefix.str + node.item);
          }
        }
      })
      return selectedPaths;
    }


    getSelectedFilePathsIncludingExtraInfo(): Array<{"path":string, extras:any}> {
      let selectedPaths: Array<{"path":string, extras:any}> = [];
      let prefix = { str: "", level: 0 };
      this.treeControl.dataNodes.forEach((node) => {
        let level_difference = prefix.level - node.level;
        if (level_difference > 0) {
          for (let i = 0; i < level_difference; ++i) {
            this.remove_folder(prefix);
          }
          level_difference = prefix.level - node.level;
        }
        if (node.expandable) {
          // "folder"
          if(this.isEmptyDir(node)){
            if (this.checklistSelection.isSelected(node)) {
              //console.log("[selected]:" + prefix.str + node.item + "\\");
              selectedPaths.push({
                "path": prefix.str + node.item + "\\",
                "extras": node.extras
              });
            }
          }else{
            if (level_difference <= 0) {
              this.add_folder(node.item, prefix);
            }
          }
        } else {
          if (this.checklistSelection.isSelected(node)) {
            // "file"
            //console.log("[selected]:" + prefix.str + node.item);
            selectedPaths.push({
              "path": prefix.str + node.item,
              "extras": node.extras
            });
          }
        }
      })
      return selectedPaths;
    }


  }